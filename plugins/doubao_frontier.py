#!/usr/bin/env python3
"""Zero-key Doubao Frontier transport, virtual Android auth cache, and protobuf codec."""

import base64
import fcntl
import hashlib
import http.client
import json
import os
import socket
import ssl
import struct
import tempfile
import threading
import time
import urllib.parse
import uuid
from typing import Any, Dict, Optional, Tuple

ANDROID_REGISTER_URL = "https://log.snssdk.com/service/2/device_register/"
ANDROID_SETTINGS_URL = "https://is.snssdk.com/service/settings/v3/"
ANDROID_FRONTIER_WS_BASE_URL = "wss://frontier-audio-ime-ws.doubao.com/ocean/api/v1/ws"
ANDROID_AID = "401734"
ANDROID_APP_NAME = "oime"
ANDROID_VERSION_CODE = "100102018"
ANDROID_VERSION_NAME = "1.1.2"
ANDROID_CHANNEL = "official"
ANDROID_PACKAGE = "com.bytedance.android.doubaoime"
ANDROID_USER_AGENT = (
    "com.bytedance.android.doubaoime/100102018 (Linux; U; Android 16; en_US; Pixel 7 Pro; "
    "Build/BP2A.250605.031.A2; Cronet/TTNetVersion:94cf429a 2025-11-17 QuicVersion:1f89f732 2025-05-08)"
)

AUTH_CACHE_TTL_SEC = 6 * 3600
MAX_WS_FRAME_BYTES = 2 * 1024 * 1024
_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class ASRError(RuntimeError):
    pass


def default_auth_cache_path() -> str:
    cfg_dir = os.environ.get("REX_ZERO_CONFIG_DIR")
    if not cfg_dir:
        xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
        cfg_dir = os.path.join(xdg, "rex-zero")
    return os.path.join(cfg_dir, "doubao-asr-auth.json")


def dial_tcp_with_env_proxy(host: str, port: int, timeout: float) -> socket.socket:
    proxy_raw = ""
    for env_key in ("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"):
        val = (os.environ.get(env_key) or "").strip()
        if val:
            proxy_raw = val
            break
    if not proxy_raw:
        return socket.create_connection((host, port), timeout=timeout)

    if "://" not in proxy_raw:
        proxy_raw = "http://" + proxy_raw
    p = urllib.parse.urlsplit(proxy_raw)
    phost = p.hostname
    if not phost:
        return socket.create_connection((host, port), timeout=timeout)
    scheme = (p.scheme or "http").lower()
    pport = p.port or (1080 if "socks" in scheme else 8080)

    sock = socket.create_connection((phost, pport), timeout=timeout)
    try:
        sock.settimeout(timeout)
        if scheme.startswith("socks5"):
            sock.sendall(b"\x05\x01\x00")
            rep = sock.recv(2)
            if rep != b"\x05\x00":
                raise ASRError("SOCKS5 proxy auth rejected")
            hb = host.encode("idna")
            sock.sendall(b"\x05\x01\x00\x03" + bytes([len(hb)]) + hb + struct.pack("!H", port))
            head = sock.recv(4)
            if len(head) < 4 or head[1] != 0x00:
                raise ASRError("SOCKS5 proxy connect failed")
            atyp = head[3]
            skip = 6 if atyp == 1 else (18 if atyp == 4 else sock.recv(1)[0] + 2)
            while skip > 0:
                got = sock.recv(skip)
                if not got:
                    break
                skip -= len(got)
            return sock

        connect_req = f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode("ascii")
        sock.sendall(connect_req)
        buf = bytearray()
        while b"\r\n\r\n" not in buf:
            if len(buf) > 16384:
                raise ASRError("HTTP proxy header too large")
            chunk = sock.recv(4096)
            if not chunk:
                raise ASRError("HTTP proxy closed during CONNECT")
            buf.extend(chunk)
        status_line = bytes(buf.split(b"\r\n", 1)[0]).decode("latin1", "replace")
        if " 200" not in status_line:
            raise ASRError(f"HTTP proxy CONNECT failed: {status_line}")
        return sock
    except Exception:
        try:
            sock.close()
        except OSError:
            pass
        raise


def _https_post_json(url: str, body: bytes, headers: Dict[str, str], timeout: float, label: str) -> Dict[str, Any]:
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ""
    port = parts.port or 443
    target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    raw = dial_tcp_with_env_proxy(host, port, timeout)
    ctx = ssl.create_default_context()
    ssl_sock = ctx.wrap_socket(raw, server_hostname=host)
    try:
        ssl_sock.settimeout(timeout)
        conn = http.client.HTTPSConnection(host, port=port, timeout=timeout, context=ctx)
        conn.sock = ssl_sock
        req_headers = dict(headers)
        req_headers["Connection"] = "close"
        conn.request("POST", target, body=body, headers=req_headers)
        resp = conn.getresponse()
        if resp.status >= 400:
            raise ASRError(f"豆包 {label} 请求失败 (HTTP {resp.status})")
        data = resp.read(262144)
        parsed = json.loads(data.decode("utf-8"))
        if not isinstance(parsed, dict):
            raise ASRError(f"豆包 {label} 响应格式异常")
        return parsed
    finally:
        try:
            ssl_sock.close()
        except OSError:
            pass


def _is_valid_did(val: Any) -> bool:
    return isinstance(val, str) and val.isascii() and val.isdigit() and 4 <= len(val) <= 32


def resolve_doubao_auth(force_refresh: bool = False) -> Tuple[str, str]:
    cache_path = default_auth_cache_path()
    parent = os.path.dirname(os.path.abspath(cache_path))
    os.makedirs(parent, mode=0o700, exist_ok=True)
    lock_path = os.path.join(parent, ".doubao-asr-auth.lock")
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        cached: Optional[Dict[str, Any]] = None
        try:
            with open(cache_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict) and _is_valid_did(str(data.get("device_id") or "")):
                cached = data
        except (OSError, ValueError):
            cached = None

        now = time.time()
        if (
            not force_refresh
            and cached
            and isinstance(cached.get("app_key"), str)
            and cached["app_key"].strip()
            and isinstance(cached.get("updated_at"), (int, float))
            and (now - float(cached["updated_at"])) < AUTH_CACHE_TTL_SEC
        ):
            return (str(cached["device_id"]), cached["app_key"].strip())

        did = str(cached.get("device_id") or "") if cached else ""
        cdid = str(cached.get("cdid") or "") if cached else ""
        if not (_is_valid_did(did) and cdid) or force_refresh:
            now_ms = int(now * 1000)
            cdid = str(uuid.uuid4())
            openudid = uuid.uuid4().hex[:16]
            clientudid = str(uuid.uuid4())
            q = urllib.parse.urlencode([
                ("device_platform", "android"), ("os", "android"), ("ssmix", "a"),
                ("_rticket", str(now_ms)), ("cdid", cdid), ("channel", ANDROID_CHANNEL),
                ("aid", ANDROID_AID), ("app_name", ANDROID_APP_NAME),
                ("version_code", ANDROID_VERSION_CODE), ("version_name", ANDROID_VERSION_NAME),
                ("manifest_version_code", ANDROID_VERSION_CODE), ("update_version_code", ANDROID_VERSION_CODE),
                ("resolution", "1080*2400"), ("dpi", "420"), ("device_type", "Pixel 7 Pro"),
                ("device_brand", "google"), ("language", "zh"), ("os_api", "34"),
                ("os_version", "16"), ("ac", "wifi"),
            ])
            reg_body = json.dumps({
                "magic_tag": "ss_app_log",
                "header": {
                    "device_id": 0, "install_id": 0, "aid": int(ANDROID_AID),
                    "app_name": ANDROID_APP_NAME, "version_code": int(ANDROID_VERSION_CODE),
                    "version_name": ANDROID_VERSION_NAME, "manifest_version_code": int(ANDROID_VERSION_CODE),
                    "update_version_code": int(ANDROID_VERSION_CODE), "channel": ANDROID_CHANNEL,
                    "package": ANDROID_PACKAGE, "device_platform": "android", "os": "android",
                    "os_api": "34", "os_version": "16", "device_type": "Pixel 7 Pro",
                    "device_brand": "google", "device_model": "Pixel 7 Pro",
                    "resolution": "1080*2400", "dpi": "420", "language": "zh", "timezone": 8,
                    "access": "wifi", "rom": "UP1A.231005.007", "rom_version": "UP1A.231005.007",
                    "openudid": openudid, "clientudid": clientudid, "cdid": cdid,
                    "region": "CN", "tz_name": "Asia/Shanghai", "tz_offset": 28800,
                    "sim_region": "cn", "carrier_region": "cn", "cpu_abi": "arm64-v8a",
                },
                "_gen_time": now_ms,
            }).encode("utf-8")
            reg = _https_post_json(
                f"{ANDROID_REGISTER_URL}?{q}",
                reg_body,
                {"User-Agent": ANDROID_USER_AGENT, "Content-Type": "application/json"},
                8.0,
                "设备注册",
            )
            did = str(reg.get("device_id") or reg.get("device_id_str") or "").strip()
            if not _is_valid_did(did):
                raise ASRError("豆包设备注册未返回有效 device_id")

        sq = urllib.parse.urlencode([
            ("device_platform", "android"), ("os", "android"), ("ssmix", "a"),
            ("_rticket", str(int(time.time() * 1000))), ("cdid", cdid),
            ("channel", ANDROID_CHANNEL), ("aid", ANDROID_AID), ("app_name", ANDROID_APP_NAME),
            ("version_code", ANDROID_VERSION_CODE), ("version_name", ANDROID_VERSION_NAME),
            ("device_id", did),
        ])
        sbody = b"body=null"
        stub = hashlib.md5(sbody).hexdigest().upper()
        settings = _https_post_json(
            f"{ANDROID_SETTINGS_URL}?{sq}",
            sbody,
            {
                "User-Agent": ANDROID_USER_AGENT,
                "x-ss-stub": stub,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            8.0,
            "获取配置",
        )
        app_key = (
            (((settings.get("data") or {}).get("settings") or {}).get("asr_config") or {}).get("app_key") or ""
        )
        if not isinstance(app_key, str) or not app_key.strip():
            raise ASRError("豆包配置缺少 asr_config.app_key")
        app_key = app_key.strip()

        fd, tmp = tempfile.mkstemp(dir=parent, prefix=".doubao-auth.")
        try:
            os.chmod(tmp, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fd = -1
                json.dump({"version": 1, "device_id": did, "cdid": cdid, "app_key": app_key, "updated_at": now}, fh)
            os.replace(tmp, cache_path)
        finally:
            if fd >= 0:
                os.close(fd)
            if os.path.exists(tmp):
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
        return (did, app_key)
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(lock_fd)


def _varint(v: int) -> bytes:
    out = bytearray()
    while v > 0x7F:
        out.append((v & 0x7F) | 0x80)
        v >>= 7
    out.append(v & 0x7F)
    return bytes(out)


def _field_bytes(num: int, data: bytes) -> bytes:
    return (_varint((num << 3) | 2) + _varint(len(data)) + data) if data else b""


def build_packet(token: str, method: str, payload: str, audio: bytes, req_id: str) -> bytes:
    return b"".join([
        _field_bytes(2, token.encode("utf-8")) if token else b"",
        _field_bytes(3, b"ASR"),
        _field_bytes(5, method.encode("utf-8")),
        _field_bytes(6, payload.encode("utf-8")) if payload else b"",
        _field_bytes(7, audio) if audio else b"",
        _field_bytes(8, req_id.encode("utf-8")),
    ])


def _read_varint(data: bytes, off: int) -> Optional[Tuple[int, int]]:
    val, shift, ln = 0, 0, len(data)
    while off < ln:
        b = data[off]
        off += 1
        val |= (b & 0x7F) << shift
        if (b & 0x80) == 0:
            return (val, off)
        shift += 7
        if shift >= 64:
            return None
    return None


def parse_response(data: bytes) -> Optional[Tuple[str, int, Optional[Dict[str, Any]]]]:
    off, ln = 0, len(data)
    event, code, payload_json = "", 20_000_000, None
    while off < ln:
        t = _read_varint(data, off)
        if t is None:
            return None
        tag, off = t
        fnum, wtype = tag >> 3, tag & 7
        if wtype == 0:
            vr = _read_varint(data, off)
            if vr is None:
                return None
            val, off = vr
            if fnum == 5:
                code = val
        elif wtype == 2:
            lr = _read_varint(data, off)
            if lr is None:
                return None
            clen, off = lr
            if off + clen > ln:
                return None
            chunk = data[off : off + clen]
            off += clen
            if fnum == 4:
                event = chunk.decode("utf-8", "replace")
            elif fnum == 7:
                try:
                    obj = json.loads(chunk.decode("utf-8"))
                    if isinstance(obj, dict):
                        payload_json = obj
                except (UnicodeDecodeError, ValueError):
                    pass
        elif wtype == 1:
            off += 8
        elif wtype == 5:
            off += 4
        else:
            return None
    return (event, code, payload_json)


class FrontierWS:
    def __init__(self, url: str) -> None:
        self.url = url
        self.sock: Optional[ssl.SSLSocket] = None
        self.rx = bytearray()
        self.tx_lock = threading.Lock()

    def connect(self, timeout: float = 6.0) -> None:
        p = urllib.parse.urlparse(self.url)
        host = p.hostname or ""
        port = p.port or 443
        path = (p.path or "/") + (f"?{p.query}" if p.query else "")
        raw = dial_tcp_with_env_proxy(host, port, timeout)
        ctx = ssl.create_default_context()
        raw.settimeout(timeout)
        ss = ctx.wrap_socket(raw, server_hostname=host)
        ws_key = base64.b64encode(os.urandom(16)).decode("ascii")
        expect = base64.b64encode(hashlib.sha1((ws_key + _WS_GUID).encode("ascii")).digest()).decode("ascii")
        req = (
            f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {ws_key}\r\nSec-WebSocket-Version: 13\r\n"
            f"User-Agent: {ANDROID_USER_AGENT}\r\nproto-version: v2\r\n"
            "x-custom-keepalive: true\r\nx-keepalive-interval: 3\r\nx-keepalive-timeout: 3600\r\n\r\n"
        ).encode("ascii")
        ss.sendall(req)
        hdr = bytearray()
        while b"\r\n\r\n" not in hdr:
            chunk = ss.recv(4096)
            if not chunk or len(hdr) > 32768:
                ss.close()
                raise ASRError("豆包 WebSocket 握手失败")
            hdr.extend(chunk)
        idx = hdr.index(b"\r\n\r\n")
        head_txt = bytes(hdr[:idx]).decode("latin1", "replace")
        if " 101 " not in head_txt.split("\r\n", 1)[0] or expect not in head_txt:
            ss.close()
            raise ASRError("豆包 WebSocket 升级被拒绝")
        self.rx.extend(hdr[idx + 4 :])
        ss.settimeout(0.8)
        self.sock = ss

    def send_bin(self, payload: bytes) -> None:
        with self.tx_lock:
            if self.sock is None:
                raise ASRError("WebSocket 已关闭")
            mask = os.urandom(4)
            ln = len(payload)
            hdr = bytearray([0x82])
            if ln < 126:
                hdr.append(0x80 | ln)
            elif ln < 65536:
                hdr.append(0x80 | 126)
                hdr.extend(struct.pack("!H", ln))
            else:
                hdr.append(0x80 | 127)
                hdr.extend(struct.pack("!Q", ln))
            masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
            self.sock.sendall(bytes(hdr) + mask + masked)

    def _fill(self, n: int) -> None:
        while len(self.rx) < n:
            if self.sock is None:
                raise EOFError()
            c = self.sock.recv(max(4096, n - len(self.rx)))
            if not c:
                raise EOFError()
            self.rx.extend(c)

    def recv_frame(self) -> Tuple[int, bytes]:
        while True:
            self._fill(2)
            b1, b2 = self.rx[0], self.rx[1]
            op, masked, ln, pos = b1 & 0x0F, (b2 & 0x80) != 0, b2 & 0x7F, 2
            if ln == 126:
                self._fill(4)
                ln, pos = struct.unpack("!H", bytes(self.rx[2:4]))[0], 4
            elif ln == 127:
                self._fill(10)
                ln, pos = struct.unpack("!Q", bytes(self.rx[2:10]))[0], 10
            if ln > MAX_WS_FRAME_BYTES:
                raise ASRError("WebSocket 帧过大")
            end = pos + (4 if masked else 0) + ln
            self._fill(end)
            if masked:
                m = bytes(self.rx[pos : pos + 4])
                data = bytes(b ^ m[i & 3] for i, b in enumerate(self.rx[pos + 4 : end]))
            else:
                data = bytes(self.rx[pos:end])
            del self.rx[:end]
            if op == 0x9:
                try:
                    with self.tx_lock:
                        if self.sock:
                            self.sock.sendall(bytes([0x8A, 0x80]) + os.urandom(4))
                except OSError:
                    pass
                continue
            if op == 0xA:
                continue
            return (op, data)

    def close(self) -> None:
        s = self.sock
        self.sock = None
        if s is not None:
            try:
                s.close()
            except OSError:
                pass
