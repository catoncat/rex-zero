#!/usr/bin/env python3
"""Live CardputerZero (`cp0`) hardware, package, and resource acceptance tests for Rex Zero.

Usage:
    python3 tests/verify_cp0_live.py --host cp0
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import unittest

TARGET_HOST = os.environ.get("CP0_SSH_HOST", "cp0")
SSH_EXTRA_OPTS: list[str] = []

APPLAUNCH_ROOT = "/usr/share/APPLaunch"
REX_ZERO_BIN = f"{APPLAUNCH_ROOT}/bin/rex-zero"
REX_ZERO_POCKET = f"{APPLAUNCH_ROOT}/share/rex-zero/rex-zero.pocket"
REX_ZERO_TSNET = f"{APPLAUNCH_ROOT}/lib/rex-zero/rex-zero-tsnet"
REX_ZERO_DOUBAO_PLUGIN = f"{APPLAUNCH_ROOT}/lib/rex-zero/plugins/doubao-asr-plugin"
REX_ZERO_ICON = f"{APPLAUNCH_ROOT}/share/images/rex-zero.png"
REX_ZERO_DESKTOP = f"{APPLAUNCH_ROOT}/applications/rex-zero.desktop"

MAX_POCKET_BYTES = int(2.5 * 1024 * 1024)
EXPECTED_RGB565_BYTES = 320 * 170 * 2  # 108,800 bytes
MAX_RSS_KIB = 72 * 1024  # < 72 MiB
MAX_IDLE_CPU_PCT = 3.0   # < 3% after 2s settle


def ssh_run(
    script: str,
    *,
    host: str | None = None,
    stdin_data: str | None = None,
    timeout: int = 30,
) -> subprocess.CompletedProcess[str]:
    target = host or TARGET_HOST
    cmd = [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        *SSH_EXTRA_OPTS,
        target,
        f"bash -lc {shlex.quote(script)}",
    ]
    return subprocess.run(
        cmd,
        input=stdin_data,
        text=True,
        capture_output=True,
        timeout=timeout,
    )


class TestCp0LiveRexZero(unittest.TestCase):
    def test_01_deb_installed_and_applaunch_layout(self) -> None:
        """1. dpkg --status rex-zero is installed and all /usr/share/APPLaunch files exist with proper modes."""
        res = ssh_run("dpkg --status rex-zero")
        self.assertEqual(res.returncode, 0, f"dpkg --status failed: {res.stderr}")
        self.assertIn("Status: install ok installed", res.stdout)

        check_files_script = f"""
        set -euo pipefail
        for f in {shlex.quote(REX_ZERO_BIN)} {shlex.quote(REX_ZERO_TSNET)} {shlex.quote(REX_ZERO_DOUBAO_PLUGIN)}; do
            test -f "$f"
            test -x "$f"
        done
        python3 {shlex.quote(REX_ZERO_DOUBAO_PLUGIN)} --check | grep -q '"doubao_free"'
        for f in {shlex.quote(REX_ZERO_POCKET)} {shlex.quote(REX_ZERO_ICON)} {shlex.quote(REX_ZERO_DESKTOP)}; do
            test -f "$f"
            test -r "$f"
        done
        stat -c '%a %s %n' \\
            {shlex.quote(REX_ZERO_BIN)} \\
            {shlex.quote(REX_ZERO_TSNET)} \\
            {shlex.quote(REX_ZERO_DOUBAO_PLUGIN)} \\
            {shlex.quote(REX_ZERO_POCKET)} \\
            {shlex.quote(REX_ZERO_ICON)} \\
            {shlex.quote(REX_ZERO_DESKTOP)}
        """
        files_res = ssh_run(check_files_script)
        self.assertEqual(files_res.returncode, 0, f"file layout check failed: {files_res.stderr}\n{files_res.stdout}")

        lines = [ln.strip() for ln in files_res.stdout.splitlines() if ln.strip()]
        self.assertEqual(len(lines), 6, f"unexpected stat output: {files_res.stdout}")
        for ln in lines:
            mode, size_s, path = ln.split(None, 2)
            size = int(size_s)
            self.assertGreater(size, 0, f"empty installed file: {path}")
            if path in (REX_ZERO_BIN, REX_ZERO_TSNET, REX_ZERO_DOUBAO_PLUGIN):
                self.assertEqual(mode, "755", f"expected mode 755 for {path}, got {mode}")
            else:
                self.assertEqual(mode, "644", f"expected mode 644 for {path}, got {mode}")

    def test_02_pocket_admitted_and_under_size_budget(self) -> None:
        """2. rex-zero --check admits rex-zero.pocket and .pocket file size is < 2.5 MiB."""
        cmd = (
            f"{shlex.quote(REX_ZERO_BIN)} --check --package {shlex.quote(REX_ZERO_POCKET)} && "
            f"stat -c '%s' {shlex.quote(REX_ZERO_POCKET)}"
        )
        res = ssh_run(cmd)
        self.assertEqual(res.returncode, 0, f"--check failed: {res.stderr}\n{res.stdout}")
        self.assertIn("package admitted", res.stdout)
        size_bytes = int(res.stdout.strip().splitlines()[-1])
        self.assertLess(
            size_bytes,
            MAX_POCKET_BYTES,
            f"rex-zero.pocket size {size_bytes} bytes exceeds 2.5 MiB ({MAX_POCKET_BYTES} bytes)",
        )

    def test_03_local_rex_server_responsive(self) -> None:
        """3. cp0 local Rex Server responds cleanly over local Unix socket."""
        script = """
        set -euo pipefail
        REX_CLI="$HOME/.local/bin/rex"
        if [ ! -x "$REX_CLI" ]; then
            REX_CLI="$(command -v rex || true)"
        fi
        test -n "$REX_CLI"
        "$REX_CLI" server status
        "$REX_CLI" ls
        """
        res = ssh_run(script)
        self.assertEqual(res.returncode, 0, f"local rex server check failed: {res.stderr}\n{res.stdout}")

    def test_04_headless_mock_shot_smoke_and_cleanup(self) -> None:
        """4. Headless --mock --shot renders valid 320x170 RGB565 frame (108,800 bytes) and cleans up."""
        smoke_dir = "/tmp/rex-zero-cp0-smoke"
        script = f"""
        set -euo pipefail
        trap 'rm -rf {shlex.quote(smoke_dir)}' EXIT
        rm -rf {shlex.quote(smoke_dir)}
        {shlex.quote(REX_ZERO_BIN)} --mock \\
            --package {shlex.quote(REX_ZERO_POCKET)} \\
            --store {shlex.quote(smoke_dir)}/store \\
            --shot {shlex.quote(smoke_dir)} \\
            --script "25:shot"
        python3 - <<'PY'
from pathlib import Path
import struct

p = Path("{smoke_dir}/25.rgb565")
assert p.is_file(), f"missing {{p}}"
raw = p.read_bytes()
assert len(raw) == {EXPECTED_RGB565_BYTES}, f"expected {EXPECTED_RGB565_BYTES} bytes, got {{len(raw)}}"
pixels = struct.unpack("<" + "H" * (len(raw) // 2), raw)
unique = set(pixels)
assert len(unique) > 4, f"rendered frame looks blank/solid (unique colors={{len(unique)}})"
print(f"SHOT_OK bytes={{len(raw)}} unique_colors={{len(unique)}}")
PY
        """
        res = ssh_run(script, timeout=120)
        self.assertEqual(res.returncode, 0, f"headless shot smoke failed: {res.stderr}\n{res.stdout}")
        self.assertIn("SHOT_OK", res.stdout)

        # Confirm cleanup completed
        verify_clean = ssh_run(f"test ! -e {shlex.quote(smoke_dir)}")
        self.assertEqual(verify_clean.returncode, 0, f"{smoke_dir} was not cleaned up")

    def test_05_tsnet_help_and_stdin_eof_zero_orphan(self) -> None:
        """5. rex-zero-tsnet --help and stdin-EOF lifecycle exit 0 with zero leftover processes."""
        smoke_dir = "/tmp/rex-zero-tsnet-smoke"
        help_res = ssh_run(f"{shlex.quote(REX_ZERO_TSNET)} --help 2>&1 || true")
        self.assertIn("state-dir", help_res.stdout + help_res.stderr)

        # Keep stdin open just long enough to read the {"type":"ready",...} line, then close stdin -> clean exit 0.
        script = f"""
        set -euo pipefail
        trap 'rm -rf {shlex.quote(smoke_dir)} /tmp/tsnet_test.py' EXIT
        rm -rf {shlex.quote(smoke_dir)} /tmp/tsnet_test.py
        mkdir -p {shlex.quote(smoke_dir)}
        cat > /tmp/tsnet_test.py <<'PY'
import json, subprocess

proc = subprocess.Popen(
    [{REX_ZERO_TSNET!r}, "--state-dir", {smoke_dir!r}, "--hostname", "rex-zero-smoke"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
)
try:
    line = proc.stdout.readline()
    assert line, f"tsnet emitted no ready line; stderr={{proc.stderr.read()}}"
    ev = json.loads(line)
    assert ev.get("type") == "ready", f"expected ready event, got {{ev}}"
    assert isinstance(ev.get("proxyPort"), int) and ev["proxyPort"] > 0, f"invalid proxyPort: {{ev}}"
    # Close stdin (EOF) -> must exit cleanly within 15s with 0 orphans
    proc.stdin.close()
    rc = proc.wait(timeout=15)
    assert rc == 0, f"expected rc=0 on stdin EOF, got {{rc}}; stderr={{proc.stderr.read()}}"
    print("TSNET_OK", json.dumps(ev))
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait(timeout=3)
PY
        python3 /tmp/tsnet_test.py
        rm -f /tmp/tsnet_test.py
        sleep 0.2
        if pgrep -f {shlex.quote(f"[r]ex-zero-tsnet --state-dir {smoke_dir}")} >/dev/null 2>&1; then
            echo "ORPHAN_FOUND"
            exit 1
        fi
        """
        res = ssh_run(script, timeout=45)
        self.assertEqual(res.returncode, 0, f"tsnet EOF test failed: {res.stderr}\n{res.stdout}")
        self.assertIn("TSNET_OK", res.stdout)

        verify_clean = ssh_run(f"test ! -e {shlex.quote(smoke_dir)}")
        self.assertEqual(verify_clean.returncode, 0, f"{smoke_dir} was not cleaned up")

    def test_06_librime_and_pinyin_schema_present(self) -> None:
        """6. librime.so.1 and /usr/share/rime-data/pinyin_simp.schema.yaml are present on cp0."""
        script = """
        set -euo pipefail
        test -f /usr/share/rime-data/pinyin_simp.schema.yaml
        if ! /sbin/ldconfig -p | grep -q 'librime\\.so\\.1'; then
            test -e /usr/lib/aarch64-linux-gnu/librime.so.1 || test -e /usr/lib/librime.so.1
        fi
        echo "RIME_OK"
        """
        res = ssh_run(script)
        self.assertEqual(res.returncode, 0, f"librime presence check failed: {res.stderr}\n{res.stdout}")
        self.assertIn("RIME_OK", res.stdout)

    def test_07_live_rss_and_idle_cpu_budget(self) -> None:
        """7. Live rex-zero process stays < 72 MiB RSS and < 3% idle CPU after 2s settle."""
        probe_dir = "/tmp/rex-zero-live-probe"
        script = f"""
        set -euo pipefail
        trap 'rm -rf {shlex.quote(probe_dir)}' EXIT
        rm -rf {shlex.quote(probe_dir)}
        python3 - <<'PY'
import os, signal, subprocess, time

def read_rss_kib(pid: int) -> int:
    with open(f"/proc/{{pid}}/status", "r", encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    raise RuntimeError(f"VmRSS not found for pid {{pid}}")

def read_proc_ticks(pid: int) -> int:
    with open(f"/proc/{{pid}}/stat", "r", encoding="utf-8") as fh:
        raw = fh.read()
    rparen = raw.rfind(")")
    fields = raw[rparen + 2:].split()
    return int(fields[11]) + int(fields[12])  # utime + stime

def find_running_rex_zero():
    out = subprocess.run(["pgrep", "-xo", "rex-zero"], text=True, capture_output=True)
    if out.returncode == 0:
        for line in out.stdout.splitlines():
            if line.strip().isdigit():
                return int(line.strip())
    return None

clk_tck = os.sysconf(os.sysconf_names["SC_CLK_TCK"])
owned_proc = None
pid = find_running_rex_zero()
if pid is None:
    os.makedirs({probe_dir!r}, exist_ok=True)
    cmd = [
        {REX_ZERO_BIN!r},
        "--mock",
        "--package", {REX_ZERO_POCKET!r},
        "--store", {probe_dir!r},
    ]
    input_ev = "/dev/input/by-path/platform-3f804000.i2c-event"
    if os.path.exists(input_ev):
        cmd.extend(["--input", input_ev])
    owned_proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    pid = owned_proc.pid

try:
    # Let 650ms active window + startup settle for >2s into kernel poll() idle sleep
    time.sleep(2.4)
    if owned_proc is not None and owned_proc.poll() is not None:
        raise RuntimeError(f"rex-zero exited prematurely rc={{owned_proc.returncode}}: {{owned_proc.stderr.read()}}")
    t0 = time.monotonic()
    ticks0 = read_proc_ticks(pid)
    time.sleep(1.5)
    t1 = time.monotonic()
    ticks1 = read_proc_ticks(pid)
    rss_kib = read_rss_kib(pid)
    cpu_pct = ((ticks1 - ticks0) / clk_tck) / max(0.1, (t1 - t0)) * 100.0
    print(f"BUDGET_OK pid={{pid}} rss_kib={{rss_kib}} cpu_pct={{cpu_pct:.2f}}")
finally:
    if owned_proc is not None and owned_proc.poll() is None:
        owned_proc.send_signal(signal.SIGTERM)
        try:
            owned_proc.wait(timeout=4)
        except subprocess.TimeoutExpired:
            owned_proc.kill()
            owned_proc.wait(timeout=2)
PY
        """
        res = ssh_run(script, timeout=30)
        self.assertEqual(res.returncode, 0, f"live budget probe failed: {res.stderr}\n{res.stdout}")
        budget_line = next((ln for ln in res.stdout.splitlines() if ln.startswith("BUDGET_OK")), "")
        self.assertTrue(budget_line, f"missing BUDGET_OK line in stdout: {res.stdout}")

        parts = dict(kv.split("=", 1) for kv in budget_line.split()[1:])
        rss_kib = int(parts["rss_kib"])
        cpu_pct = float(parts["cpu_pct"])
        self.assertLess(
            rss_kib,
            MAX_RSS_KIB,
            f"live RSS {rss_kib / 1024:.1f} MiB exceeds {MAX_RSS_KIB // 1024} MiB limit",
        )
        self.assertLess(
            cpu_pct,
            MAX_IDLE_CPU_PCT,
            f"settled idle CPU {cpu_pct:.2f}% exceeds {MAX_IDLE_CPU_PCT:.1f}% limit",
        )


def parse_args(argv: list[str]) -> list[str]:
    global TARGET_HOST, SSH_EXTRA_OPTS
    parser = argparse.ArgumentParser(description="Live cp0 hardware & resource verification for Rex Zero")
    parser.add_argument("--host", default=TARGET_HOST, help="SSH host alias/target for CardputerZero (default: cp0)")
    parser.add_argument(
        "--ssh-opt",
        action="append",
        default=[],
        help="Additional ssh -o option (repeatable, e.g. HostKeyAlias=192.168.2.250)",
    )
    args, remaining = parser.parse_known_args(argv)
    TARGET_HOST = args.host
    SSH_EXTRA_OPTS = [tok for opt in args.ssh_opt for tok in ("-o", opt)]
    return [sys.argv[0], *remaining]


if __name__ == "__main__":
    unittest_argv = parse_args(sys.argv[1:])
    unittest.main(argv=unittest_argv, verbosity=2)
