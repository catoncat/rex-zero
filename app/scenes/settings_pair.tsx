// Scene 3: Pure-black Tailnet & 5-Minute QR Pairing (320x170).
// Left 124x124 crisp QR box; Right 184px status, peer list & import confirm.

import { For, Index, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import { SLOT, createSelection, ellipsize } from "@pocketjs/framework/compact/primitives";
import type { TailnetPeer } from "../types.ts";
import { findMatchingHost, isRexPeerNode, rexClient, shortHostLabel, wrapCjk } from "../client.ts";
import { openHelp, toast, useKey, useNav, type HelpRow, type SceneDef } from "../frame.tsx";
import { THEME } from "../theme.ts";

const QR_TEXTURE = 64;
const PSM_8888 = 3;
const QR_BOX = 124;

const SETTINGS_HELP: readonly HelpRow[] = [
  { keys: "Tab  Z/C", desc: "切换 Tailscale ↔ 扫码配对" },
  { keys: "F/X  ↑/↓", desc: "上下选择组网节点" },
  { keys: "⏎ Enter", desc: "启停组网 / 添加重连主机 / 生码" },
  { keys: "BS 退格", desc: "拒绝待导入配置 / 返回上页" },
  { keys: "Esc", desc: "返回对话列表" },
];

interface QrTexInfo {
  handle: number;
  size: number;
  scale: number;
  off: number;
}

function uploadQrMatrix(matrix: boolean[][] | null | undefined, boxSize: number): QrTexInfo | null {
  if (!matrix || matrix.length === 0 || matrix.length > QR_TEXTURE) return null;
  const n = matrix.length;
  const pad = 4;
  const scale = Math.max(1, Math.min(3, Math.floor((boxSize - pad * 2) / n)));
  const off = Math.floor((boxSize - n * scale) / 2);
  const rgba = new Uint8Array(QR_TEXTURE * QR_TEXTURE * 4).fill(255);
  let darkCount = 0;
  for (let y = 0; y < n; y++) {
    const row = matrix[y];
    if (!row) continue;
    for (let x = 0; x < n && x < row.length; x++) {
      if (!row[x]) continue;
      darkCount++;
      const at = (y * QR_TEXTURE + x) * 4;
      rgba[at] = rgba[at + 1] = rgba[at + 2] = 0;
    }
  }
  if (darkCount === 0) return null;
  const handle = getOps().uploadTexture(rgba, QR_TEXTURE, QR_TEXTURE, PSM_8888);
  return handle < 0 ? null : { handle, size: n, scale, off };
}

type TsRow =
  | { kind: "toggle" }
  | { kind: "peer"; peer: TailnetPeer };

export function createSettingsPairScene(initialTab: 0 | 1 = 0): SceneDef {
  return {
    title: "组网与扫码配对",
    render: () => <SettingsPairView initialTab={initialTab} />,
  };
}

function SettingsPairView(props: { initialTab: 0 | 1 }): JSX.Element {
  const [tab, setTab] = createSignal<0 | 1>(props.initialTab);
  const [busy, setBusy] = createSignal(false);

  const tailnet = () => rexClient.fleet()?.tailnet;
  const pair = () => rexClient.fleet()?.pair;
  const asr = () => rexClient.fleet()?.asr;

  const tsRows = createMemo<TsRow[]>(() => {
    const peers = tailnet()?.peers ?? [];
    return [{ kind: "toggle" }, ...peers.map(peer => ({ kind: "peer" as const, peer }))];
  });

  const tsSel = createSelection(() => tsRows().length, 0);

  const triggerTsRow = (idx: number) => {
    if (busy()) return;
    const row = tsRows()[idx];
    if (!row) return;
    if (row.kind === "toggle") {
      const next = !(tailnet()?.enabled ?? false);
      setBusy(true);
      toast(next ? "正在启动 Tailscale..." : "正在停止 Tailscale...", "dim");
      void rexClient
        .dispatchAction({ op: "tsnet_set", enabled: next })
        .then(r => {
          if (!r.ok) toast(r.error || "操作失败", "warn");
          else toast(next ? "已启动 Tailscale" : "已关闭 Tailscale", "ok");
        })
        .finally(() => setBusy(false));
      return;
    }
    const peer = row.peer;
    const existing = findMatchingHost(peer, rexClient.fleet()?.hosts ?? []);
    if (peer.alreadyAdded && existing?.phase === "live") {
      toast(`${peer.hostName} 已在线`, "ok");
      return;
    }
    const reconnecting = Boolean(peer.alreadyAdded || existing);
    setBusy(true);
    const mode = isRexPeerNode(peer) ? "https" : "ssh";
    if (reconnecting) toast(`正在重连 ${peer.hostName}...`, "dim");
    void rexClient
      .dispatchAction({
        op: "tsnet_add_peer",
        dnsName: peer.dnsName || peer.hostName,
        hostName: peer.hostName,
        mode,
      })
      .then(r => {
        if (!r.ok) toast(r.error || "添加节点失败", "warn");
        else toast(reconnecting ? `正在重连 ${peer.hostName}` : `已添加 ${peer.hostName}`, "ok");
      })
      .finally(() => setBusy(false));
  };

  const togglePairing = () => {
    if (busy()) return;
    const next = !(pair()?.active ?? false);
    setBusy(true);
    void rexClient
      .dispatchAction({ op: "pair_toggle", active: next })
      .then(r => {
        if (!r.ok) toast(r.error || "切换配对失败", "warn");
        else toast(next ? "已开启5分钟扫码配对" : "已关闭配对服务", "ok");
      })
      .finally(() => setBusy(false));
  };

  const confirmPairImport = (approve: boolean) => {
    if (busy()) return;
    const pending = pair()?.pendingImport;
    if (!pending) return;
    setBusy(true);
    void rexClient
      .dispatchAction({ op: "pair_confirm", approve, token: pending.token })
      .then(r => {
        if (!r.ok) toast(r.error || "导入失败", "warn");
        else toast(approve ? "已确认导入配置" : "已拒绝此次导入", approve ? "ok" : "dim");
      })
      .finally(() => setBusy(false));
  };

  useKey(event => {
    if (rexClient.quickSwitchOpen()) return;
    if (event.kind !== "key" || !event.pressed) return;
    const k = event.key;
    if (k === "?" || k === "h" || k === "H") {
      openHelp("组网与配对快捷键", SETTINGS_HELP);
      return true;
    }
    if (tab() === 1 && pair()?.pendingImport) {
      if (k === "Backspace") {
        confirmPairImport(false);
        return true;
      }
      if (k === "Enter") {
        confirmPairImport(true);
        return true;
      }
    }
    return false;
  });

  useNav(event => {
    if (rexClient.quickSwitchOpen()) return;
    if (event.key === "left" || event.key === "right" || event.key === "action") {
      setTab(t => (t === 0 ? 1 : 0));
      return true;
    }
    if (tab() === 0) {
      if (event.key === "up") {
        tsSel.move(-1);
        return true;
      }
      if (event.key === "down") {
        tsSel.move(1);
        return true;
      }
      if (event.key === "ok") {
        triggerTsRow(tsSel.index());
        return true;
      }
    } else if (event.key === "ok") {
      if (pair()?.pendingImport) confirmPairImport(true);
      else togglePairing();
      return true;
    }
    return false;
  });

  const qrKey = createMemo(() => {
    if (tab() === 0) {
      const u = tailnet()?.authUrl ?? "";
      return tailnet()?.qrMatrix ? `ts:${u}` : "";
    }
    return pair()?.active && pair()?.qrMatrix ? `pair:${pair()?.url ?? ""}:${pair()?.pin ?? ""}` : "";
  });

  const [qrTex, setQrTex] = createSignal<QrTexInfo | null>(null);
  let qrImgNode: NodeMirror | undefined;
  let activeTexHandle = -1;

  const releaseQrTex = () => {
    if (activeTexHandle >= 0) {
      getOps().freeTexture?.(activeTexHandle);
      activeTexHandle = -1;
    }
  };
  onCleanup(releaseQrTex);

  createEffect(() => {
    const key = qrKey();
    releaseQrTex();
    if (!key) {
      setQrTex(null);
      if (qrImgNode) getOps().setImage(qrImgNode.id, -1);
      return;
    }
    const matrix = tab() === 0 ? tailnet()?.qrMatrix : pair()?.qrMatrix;
    const uploaded = uploadQrMatrix(matrix, QR_BOX);
    if (uploaded) {
      activeTexHandle = uploaded.handle;
      setQrTex(uploaded);
      if (qrImgNode) getOps().setImage(qrImgNode.id, uploaded.handle);
    } else {
      setQrTex(null);
      if (qrImgNode) getOps().setImage(qrImgNode.id, -1);
    }
  });

  const tsVisible = 4;
  const tsFirst = createMemo(() => {
    const idx = tsSel.index();
    return Math.max(0, Math.min(idx - tsVisible + 1, Math.max(0, tsRows().length - tsVisible)));
  });
  const tsSlice = createMemo(() => tsRows().slice(tsFirst(), tsFirst() + tsVisible));

  return (
    <View class="absolute left-0 top-0 w-[320] h-[170]" style={{ bgColor: THEME.bg }}>
      {/* Top 20px Header */}
      <View class="absolute left-0 top-0 w-[320] h-[20]" style={{ bgColor: THEME.bg }}>
        <Text
          class="absolute text-xs font-bold leading-[18]"
          style={{ insetL: 6, insetT: 1, textColor: tab() === 0 ? THEME.text : THEME.dim }}
        >
          Tailscale 组网
        </Text>
        <Show when={tab() === 0}>
          <View class="absolute h-[2]" style={{ insetL: 5, insetT: 18, width: 82, bgColor: THEME.amber }} />
        </Show>

        <Text
          class="absolute text-xs font-bold leading-[18]"
          style={{ insetL: 98, insetT: 1, textColor: tab() === 1 ? THEME.text : THEME.dim }}
        >
          扫码导配置
        </Text>
        <Show when={tab() === 1}>
          <View class="absolute h-[2]" style={{ insetL: 97, insetT: 18, width: 64, bgColor: THEME.amber }} />
        </Show>

        <Text class="absolute text-xs leading-[18] text-right" style={{ insetL: 244, insetT: 1, width: 70, textColor: THEME.dim }}>
          Esc返回
        </Text>
        <View class="absolute left-0 w-[320] h-[1]" style={{ insetT: 19, bgColor: THEME.line }} />
      </View>

      {/* Left 124x124 QR Code Box */}
      <View
        class="absolute rounded-sm border"
        style={{
          insetL: 4,
          insetT: 26,
          width: QR_BOX,
          height: QR_BOX,
          bgColor: qrTex() ? "#ffffff" : THEME.panel,
          borderColor: qrTex() ? "#ffffff" : THEME.border,
        }}
      >
        <Show
          when={qrTex()}
          fallback={
            <View class="absolute left-0 top-0" style={{ width: QR_BOX, height: QR_BOX }}>
              <Text class="absolute left-0 text-xs font-bold leading-[16] text-center" style={{ insetT: 42, width: QR_BOX - 2, textColor: THEME.text }}>
                {tab() === 0
                  ? tailnet()?.backendState === "Running"
                    ? "Tailscale 在线"
                    : "等待登录码"
                  : "未开启配对码"}
              </Text>
              <Text class="absolute left-0 text-xs leading-[16] text-center" style={{ insetT: 62, width: QR_BOX - 2, textColor: THEME.dim }}>
                {tab() === 0
                  ? tailnet()?.backendState === "Running"
                    ? ellipsize(tailnet()?.tailnetName || "已连接", SLOT.xs, QR_BOX - 10)
                    : "按 ⏎ 启用组网"
                  : "按 ⏎ 生成5分钟码"}
              </Text>
            </View>
          }
        >
          {tex => (
            <View
              class="absolute overflow-hidden"
              style={{
                insetL: tex().off,
                insetT: tex().off,
                width: tex().size * tex().scale,
                height: tex().size * tex().scale,
              }}
            >
              <Image
                nodeRef={(node: NodeMirror) => {
                  qrImgNode = node;
                  const cur = qrTex();
                  if (cur) getOps().setImage(node.id, cur.handle);
                }}
                class="absolute left-0 top-0"
                style={{
                  width: QR_TEXTURE * tex().scale,
                  height: QR_TEXTURE * tex().scale,
                }}
              />
            </View>
          )}
        </Show>
      </View>

      {/* Right Column (x=134..316, width 182px) */}
      <View class="absolute" style={{ insetL: 134, insetT: 26, width: 182, height: 138 }}>
        <Show when={tab() === 0}>
          <Text
            class="absolute left-0 top-0 text-xs font-bold leading-[16]"
            style={{
              textColor:
                tailnet()?.backendState === "Running"
                  ? THEME.cyan
                  : tailnet()?.error
                    ? THEME.rose
                    : THEME.amber,
            }}
          >
            {ellipsize(
              `状态: ${tailnet()?.backendState || (tailnet()?.enabled ? "启动中" : "已停用")}`,
              SLOT.xsBold,
              180,
            )}
          </Text>
          <Text class="absolute left-0 text-xs leading-[15]" style={{ insetT: 17, textColor: THEME.dim }}>
            {ellipsize(
              tailnet()?.error
                ? `错误: ${tailnet()!.error}`
                : tailnet()?.selfDns || tailnet()?.authUrl || "用户态直连 · 零冲突",
              SLOT.xs,
              180,
            )}
          </Text>

          {/* Toggle + Peers list (4 rows x 24px at y=36..132) */}
          <Index each={tsSlice()}>
            {(row, localIdx) => {
              const absIdx = () => tsFirst() + localIdx;
              const focused = () => tsSel.index() === absIdx();
              const peer = () => {
                const r = row();
                return r.kind === "peer" ? r.peer : null;
              };
              const badge = () => {
                const p = peer();
                if (!p) return { text: "", color: THEME.dim };
                const m = findMatchingHost(p, rexClient.fleet()?.hosts ?? []);
                if (p.alreadyAdded || m) {
                  if (m?.phase === "live") return { text: "已连", color: THEME.cyan };
                  if (m?.phase === "failed") return { text: "重连", color: THEME.rose };
                  return { text: "连接中", color: THEME.amber };
                }
                if (!p.online) return { text: "离线", color: THEME.dim };
                if (isRexPeerNode(p)) return { text: "Rex+", color: THEME.cyan };
                return { text: "+SSH", color: THEME.amber };
              };
              return (
                <View
                  class="absolute left-0 rounded-sm"
                  style={{
                    insetT: 36 + localIdx * 24,
                    width: 182,
                    height: 22,
                    bgColor: focused() ? THEME.sel : THEME.panel,
                  }}
                >
                  <Show when={focused()}>
                    <View class="absolute left-0 top-0 w-[2]" style={{ height: 22, bgColor: THEME.amber }} />
                  </Show>
                  <Show
                    when={Boolean(peer())}
                    fallback={
                      <Text
                        class="absolute text-xs font-bold leading-[22]"
                        style={{ insetL: 6, insetT: 0, textColor: focused() ? THEME.amber : THEME.text }}
                      >
                        {tailnet()?.enabled ? "[⏎ 停用 Tailscale]" : "[⏎ 启用 Tailscale]"}
                      </Text>
                    }
                  >
                    <>
                      <View
                        class="absolute w-[4] h-[4]"
                        style={{ insetL: 6, insetT: 9, bgColor: peer()?.online ? THEME.cyan : THEME.dim }}
                      />
                      <Text
                        class="absolute text-xs leading-[22]"
                        style={{ insetL: 14, insetT: 0, textColor: focused() ? THEME.text : THEME.muted }}
                      >
                        {ellipsize(
                          peer() ? shortHostLabel(peer()!.hostName, peer()!.dnsName) || peer()!.hostName : "",
                          SLOT.xs,
                          116,
                        )}
                      </Text>
                      <Text
                        class="absolute text-xs leading-[22] text-right"
                        style={{ insetL: 132, insetT: 0, width: 46, textColor: badge().color }}
                      >
                        {badge().text}
                      </Text>
                    </>
                  </Show>
                </View>
              );
            }}
          </Index>
        </Show>

        <Show when={tab() === 1}>
          <Show
            when={pair()?.pendingImport}
            fallback={
              <>
                <Text
                  class="absolute left-0 top-0 text-xs font-bold leading-[16]"
                  style={{ textColor: pair()?.active ? THEME.cyan : THEME.amber }}
                >
                  {pair()?.active ? `配对中 · ${pair()!.expiresInSec}s` : "5分钟扫码导入配置"}
                </Text>
                <Text class="absolute left-0 text-sm leading-[18]" style={{ insetT: 20, textColor: THEME.amber }}>
                  {pair()?.active ? `PIN: ${pair()!.pin}` : "导入主机/密钥/语音"}
                </Text>
                <Text class="absolute left-0 text-xs leading-[16]" style={{ insetT: 42, textColor: THEME.muted }}>
                  {pair()?.active ? ellipsize(pair()!.url, SLOT.xs, 180) : "手机扫码提交后本机确认"}
                </Text>
                <Text class="absolute left-0 text-xs leading-[16]" style={{ insetT: 62, textColor: THEME.dim }}>
                  {`语音: ${asr()?.configured ? `${asr()!.provider} 已配置` : "未配置"}`}
                </Text>
                <Text class="absolute left-0 text-xs leading-[16]" style={{ insetT: 80, textColor: THEME.dim }}>
                  {`拼音: ${rexClient.fleet()?.ime.engine === "librime" ? "librime" : "内置"}`}
                </Text>

                <View
                  class="absolute left-0 rounded-sm"
                  style={{ insetT: 106, width: 180, height: 22, bgColor: THEME.amber }}
                >
                  <Text
                    class="absolute left-0 top-0 text-xs font-bold leading-[22] text-center"
                    style={{ width: 180, textColor: THEME.darkInk }}
                  >
                    {pair()?.active ? "⏎ 关闭配对服务" : "⏎ 生成5分钟配对码"}
                  </Text>
                </View>
              </>
            }
          >
            {imp => {
              const summaryLines = createMemo(() => wrapCjk(imp().summary, SLOT.xs, 168).slice(0, 2));
              return (
                <View
                  class="absolute left-0 top-0 rounded-sm border"
                  style={{ width: 182, height: 132, bgColor: THEME.modal, borderColor: THEME.amber }}
                >
                  <Text class="absolute text-xs font-bold leading-[16]" style={{ insetL: 6, insetT: 4, textColor: THEME.amber }}>
                    收到待导入配置
                  </Text>
                  <Text class="absolute text-xs leading-[15]" style={{ insetL: 6, insetT: 21, textColor: THEME.muted }}>
                    {ellipsize(`来源: ${imp().fromIp}`, SLOT.xs, 168)}
                  </Text>
                  <For each={summaryLines()}>
                    {(line, i) => (
                      <Text class="absolute text-xs leading-[15]" style={{ insetL: 6, insetT: 39 + i() * 16, textColor: THEME.text }}>
                        {line}
                      </Text>
                    )}
                  </For>

                  <View class="absolute rounded-sm" style={{ insetL: 6, insetT: 80, width: 168, height: 20, bgColor: THEME.amber }}>
                    <Text class="absolute left-0 top-0 text-xs font-bold leading-[20] text-center" style={{ width: 168, textColor: THEME.darkInk }}>
                      ⏎ 确认导入
                    </Text>
                  </View>
                  <View
                    class="absolute rounded-sm border"
                    style={{ insetL: 6, insetT: 104, width: 168, height: 20, bgColor: THEME.panel, borderColor: THEME.rose }}
                  >
                    <Text class="absolute left-0 top-0 text-xs font-bold leading-[18] text-center" style={{ width: 166, textColor: THEME.rose }}>
                      BS 拒绝
                    </Text>
                  </View>
                </View>
              );
            }}
          </Show>
        </Show>
      </View>
    </View>
  );
}
