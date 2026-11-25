#!/usr/bin/env python3
"""Builds official libghostty-vt static archives (host + aarch64-linux-gnu.2.36)
from the pinned Ghostty vt-1.0.1 tarball in native/ghostty/source.json."""
import hashlib
import json
import os
import platform
import subprocess
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / "native/ghostty"
BUILD = ROOT / ".build/ghostty"


def run(cmd, **kwargs):
    subprocess.run([str(v) for v in cmd], check=True, **kwargs)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, expected: str, path: Path) -> None:
    if path.exists() and sha256(path) == expected:
        return
    part = path.with_suffix(path.suffix + ".part")
    run(["curl", "-fL", "--retry", "2", url, "-o", part])
    actual = sha256(part)
    if actual != expected:
        raise RuntimeError(f"checksum mismatch for {url}: {actual} != {expected}")
    part.replace(path)


def extract(archive: Path, destination: Path) -> None:
    if destination.exists():
        return
    base = destination.parent.resolve()
    with tarfile.open(archive) as tar:
        tar.extractall(base)


def main() -> None:
    manifest = json.loads((NATIVE / "source.json").read_text())
    arch = {"arm64": "aarch64", "aarch64": "aarch64", "x86_64": "x86_64"}[platform.machine()]
    host = {"Darwin": "macos", "Linux": "linux"}[platform.system()]
    cache = BUILD / "cache"
    cache.mkdir(parents=True, exist_ok=True)

    zig_info = manifest["zig"][f"{arch}-{host}"]
    zig_archive = cache / Path(zig_info["tarball"]).name
    source_archive = cache / f"ghostty-{manifest['revision']}.tar.gz"
    download(zig_info["tarball"], zig_info["shasum"], zig_archive)
    download(manifest["source_url"], manifest["source_sha256"], source_archive)

    zig_root = cache / zig_archive.name.removesuffix(".tar.xz")
    source_root = cache / f"ghostty-{manifest['revision']}"
    extract(zig_archive, zig_root)
    extract(source_archive, source_root)

    env = os.environ.copy()
    if not env.get("GHOSTTY_ZIG_KEEP_PROXY"):
        for name in ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
            env.pop(name, None)
    env.setdefault("ZIG_GLOBAL_CACHE_DIR", str(BUILD / "zig-cache"))

    zig_bin = zig_root / "zig"
    common = [
        zig_bin,
        "build",
        "-Demit-lib-vt",
        "-Demit-macos-app=false",
        "-Demit-xcframework=false",
        "-Doptimize=ReleaseFast",
    ]

    host_prefix = BUILD / "prefix-host"
    if not (host_prefix / "lib/libghostty-vt.a").exists():
        run([*common, "--prefix", host_prefix], cwd=source_root, env=env)
        print(f"built host libghostty-vt: {host_prefix / 'lib/libghostty-vt.a'}")

    linux_prefix = BUILD / "prefix-linux-arm64"
    if not (linux_prefix / "lib/libghostty-vt.a").exists():
        run([*common, "-Dtarget=aarch64-linux-gnu.2.36", "--prefix", linux_prefix], cwd=source_root, env=env)
        print(f"built linux-arm64 libghostty-vt: {linux_prefix / 'lib/libghostty-vt.a'}")

    print("GHOSTTY_VT_BUILD_OK")


if __name__ == "__main__":
    main()
