#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAILNET_DIR="$ROOT_DIR/tailnet"
OUT_DIR="$ROOT_DIR/.build/tsnet"
GO_BIN="/opt/homebrew/bin/go"

if [[ ! -x "$GO_BIN" ]]; then
  GO_BIN="$(command -v go)"
fi

OMIT_TAGS="ts_omit_logtail,ts_omit_ssh,ts_omit_taildrop,ts_omit_drive,ts_omit_webclient,ts_omit_doctor,ts_omit_capture,ts_omit_kube,ts_omit_aws,ts_omit_synology,ts_omit_bird,ts_omit_tap,ts_omit_tpm,ts_omit_appconnectors,ts_omit_clientupdate,ts_omit_relayserver,ts_omit_portlist,ts_omit_wakeonlan,ts_omit_advertiseexitnode,ts_omit_advertiseroutes,ts_omit_flashappliance,ts_omit_systray,ts_omit_dbus,ts_omit_networkmanager,ts_omit_resolved,ts_omit_iptables,ts_omit_sdnotify,ts_omit_syslog,ts_omit_completion,ts_omit_qrcodes,ts_omit_cli"

mkdir -p "$OUT_DIR"

cd "$TAILNET_DIR"

echo "Building rex-zero-tsnet-host..."
CGO_ENABLED=0 "$GO_BIN" build \
  -tags "$OMIT_TAGS" \
  -trimpath \
  -ldflags="-s -w -buildid=" \
  -o "$OUT_DIR/rex-zero-tsnet-host" \
  .

echo "Building rex-zero-tsnet-linux-arm64..."
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 "$GO_BIN" build \
  -tags "$OMIT_TAGS" \
  -trimpath \
  -ldflags="-s -w -buildid=" \
  -o "$OUT_DIR/rex-zero-tsnet-linux-arm64" \
  .

ls -lh "$OUT_DIR/rex-zero-tsnet-host" "$OUT_DIR/rex-zero-tsnet-linux-arm64"
