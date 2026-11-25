#!/usr/bin/env python3
"""Zero-key Doubao Frontier streaming ASR plugin for Rex Zero Native.

Standard Rex Zero ASR Plugin Protocol:
- Input (`stdin`): raw 16kHz 16-bit signed little-endian mono PCM (`S16_LE`).
- Output (`stdout`): UTF-8 JSON Lines (flushed immediately):
    {"status": "ready"}
    {"partial": "实时识别中文本"}
    {"final": "最终识别结果"}
    {"error": "错误说明"}
- CLI `--check`: prints `{"ok": true, "provider": "doubao_free"}` and exits 0.
"""

import json
import os
import socket
import sys
import threading
import time
import urllib.parse
import uuid
from typing import Any, Dict, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from doubao_frontier import (  # noqa: E402
    ANDROID_AID,
    ANDROID_FRONTIER_WS_BASE_URL,
    ASRError,
    FrontierWS,
    build_packet,
    parse_response,
    resolve_doubao_auth,
)

SAMPLE_RATE = 16000
PCM_CHUNK_BYTES = 640  # 20ms @ 16kHz S16_LE mono
MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 60
_PUNCT_CHARS = set("。，！？,.!?")


def emit_jsonl(obj: Dict[str, Any]) -> None:
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except OSError:
        pass


def _join_seg(a: str, b: str) -> str:
    a, b = a.strip(), b.strip()
    if not a:
        return b
    if not b:
        return a
    if a[-1].isascii() and a[-1].isalnum() and b[0].isascii() and b[0].isalnum():
        return f"{a} {b}"
    return a + b


def run_stream() -> int:
    session_id = str(uuid.uuid4()).upper()
    ws: Optional[FrontierWS] = None
    app_key = ""
    for attempt in range(2):
        did, app_key = resolve_doubao_auth(force_refresh=(attempt > 0))
        url = f"{ANDROID_FRONTIER_WS_BASE_URL}?aid={ANDROID_AID}&device_id={urllib.parse.quote(did, safe='')}"
        ws = FrontierWS(url)
        try:
            ws.connect(timeout=6.0)
            cfg = json.dumps({
                "audio_info": {"channel": 1, "format": "pcm", "sample_rate": SAMPLE_RATE},
                "enable_punctuation": True,
                "enable_speech_rejection": False,
                "extra": {
                    "app_name": "com.android.chrome",
                    "cell_compress_rate": 8,
                    "enable_asr_threepass": True,
                    "enable_asr_twopass": True,
                    "input_mode": "tool",
                },
            }, ensure_ascii=False, separators=(",", ":"))
            ws.send_bin(build_packet(app_key, "StartTask", "", b"", session_id))
            ws.send_bin(build_packet(app_key, "StartSession", cfg, b"", session_id))
            break
        except Exception:
            ws.close()
            if attempt == 1:
                raise

    assert ws is not None
    cond = threading.Condition()
    state: Dict[str, Any] = {
        "ready": False,
        "done": False,
        "finished_ok": False,
        "error": "",
        "segments": {},
        "finals": {},
        "unindexed_par": "",
        "unindexed_fin": "",
        "last_emitted": "",
    }

    def compose_text(prefer_final: bool) -> str:
        joined = ""
        segs, fins = state["segments"], state["finals"]
        for k in sorted(set(segs) | set(fins)):
            s = (fins.get(k) or segs.get(k) or "") if prefer_final else (segs.get(k) or fins.get(k) or "")
            if any(ch.isalnum() for ch in s):
                joined = _join_seg(joined, s)
        tail = (
            (state["unindexed_fin"] or state["unindexed_par"])
            if prefer_final
            else (state["unindexed_par"] or state["unindexed_fin"])
        )
        if any(ch.isalnum() for ch in tail):
            joined = _join_seg(joined, tail)
        return joined

    def reader_loop() -> None:
        while True:
            try:
                op, data = ws.recv_frame()
            except socket.timeout:
                with cond:
                    if state["done"]:
                        return
                continue
            except Exception as exc:
                with cond:
                    if not state["done"] and not state["error"]:
                        state["error"] = f"连接中断: {exc}"
                    state["done"] = True
                    cond.notify_all()
                return
            if op == 0x8:
                with cond:
                    if not state["finished_ok"] and not state["error"]:
                        state["error"] = "豆包语音会话连接提前关闭"
                    state["done"] = True
                    cond.notify_all()
                return
            if op != 0x2:
                continue
            parsed = parse_response(data)
            if not parsed:
                continue
            ev, code, pjson = parsed
            with cond:
                if code != 20_000_000:
                    state["error"] = f"豆包识别失败 ({code})"
                    state["done"] = True
                    cond.notify_all()
                    return
                if ev == "SessionStarted":
                    state["ready"] = True
                elif ev in ("SessionFinished", "TaskFinished"):
                    state["finished_ok"] = True
                    state["done"] = True
                if isinstance(pjson, dict) and isinstance(pjson.get("results"), list):
                    for item in pjson["results"]:
                        if not isinstance(item, dict):
                            continue
                        txt = (item.get("text") or "").strip() if isinstance(item.get("text"), str) else ""
                        if not txt or not any(ch.isalnum() for ch in txt):
                            continue
                        extra = item.get("extra") if isinstance(item.get("extra"), dict) else {}
                        is_term = bool(extra.get("nonstream_result")) or (
                            item.get("is_interim") is False and bool(item.get("is_vad_finished"))
                        )
                        idx = (
                            item.get("index")
                            if isinstance(item.get("index"), int) and not isinstance(item.get("index"), bool)
                            else None
                        )
                        if idx is None:
                            state["unindexed_par"] = txt
                            if is_term and sum(1 for c in txt if c in _PUNCT_CHARS) >= sum(
                                1 for c in state["unindexed_fin"] if c in _PUNCT_CHARS
                            ):
                                state["unindexed_fin"] = txt
                        else:
                            state["segments"][idx] = txt
                            if is_term:
                                state["finals"][idx] = txt
                    cur_par = compose_text(False)
                    if cur_par and cur_par != state["last_emitted"]:
                        state["last_emitted"] = cur_par
                        emit_jsonl({"partial": cur_par})
                cond.notify_all()
                if state["done"]:
                    return

    rt = threading.Thread(target=reader_loop, daemon=True)
    rt.start()

    with cond:
        deadline = time.monotonic() + 6.0
        while not state["ready"] and not state["done"] and not state["error"]:
            rem = deadline - time.monotonic()
            if rem <= 0:
                ws.close()
                raise ASRError("豆包语音会话启动超时")
            cond.wait(timeout=rem)
        if state["error"] or not state["ready"]:
            ws.close()
            raise ASRError(state["error"] or "豆包语音会话在就绪前已关闭")

    emit_jsonl({"status": "ready"})

    buf = bytearray()
    total = 0
    stdin_fd = sys.stdin.fileno()
    while total < MAX_AUDIO_BYTES:
        chunk = os.read(stdin_fd, 1600)
        if not chunk:
            break
        total += len(chunk)
        buf.extend(chunk)
        while len(buf) >= PCM_CHUNK_BYTES:
            with cond:
                if state["done"]:
                    buf.clear()
                    break
            frame = bytes(buf[:PCM_CHUNK_BYTES])
            del buf[:PCM_CHUNK_BYTES]
            meta = f'{{"timestamp_ms":{int(time.time() * 1000)}}}'
            ws.send_bin(build_packet("", "TaskRequest", meta, frame, session_id))

    if buf:
        if len(buf) % 2 == 1:
            buf.append(0)
        meta = f'{{"timestamp_ms":{int(time.time() * 1000)}}}'
        try:
            ws.send_bin(build_packet("", "TaskRequest", meta, bytes(buf), session_id))
        except Exception:
            pass

    try:
        ws.send_bin(build_packet(app_key, "FinishSession", "", b"", session_id))
    except Exception:
        pass

    with cond:
        fin_deadline = time.monotonic() + 5.0
        while not state["done"]:
            rem = fin_deadline - time.monotonic()
            if rem <= 0:
                break
            cond.wait(timeout=rem)
        term_txt = compose_text(True)
        final_txt = term_txt or compose_text(False)
        err_txt = state["error"]
        finished_ok = state["finished_ok"]

    ws.close()
    if err_txt or (not finished_ok and not term_txt):
        emit_jsonl({"error": err_txt or "豆包语音识别收尾超时"})
        return 1
    emit_jsonl({"final": final_txt.strip()})
    return 0


def main() -> int:
    if "--check" in sys.argv[1:]:
        emit_jsonl({"ok": True, "provider": "doubao_free"})
        return 0
    try:
        return run_stream()
    except ASRError as exc:
        emit_jsonl({"error": str(exc)})
        return 1
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        emit_jsonl({"error": f"豆包语音插件异常: {exc}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
