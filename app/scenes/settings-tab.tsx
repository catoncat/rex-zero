// Tab 2 (`设置`, 320x150): Unified Settings & Multi-Connection Center.
// Supports all 4 connection methods (Tailscale, inline SSH user@host, inline TCP/HTTPS, 5-min QR Web Pairing),
// Global Font Size & Crispness, Pluggable ASR Provider (built-in zero-key Doubao default), Reader Mode, Mute, and Saved Hosts.

import { Index, Show, createMemo, createSignal, type Accessor, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { SLOT, createSelection, display, ellipsize, measure } from "@pocketjs/framework/compact/primitives";
import type { AsrProviderId, FleetSnapshot, HostState } from "../types.ts";
import { navigateToSettings, rexClient, shortHostLabel } from "../client.ts";
import { toast } from "../frame.tsx";
import { FONT_PRESETS, THEME, getFontPreset, type ReaderViewMode } from "../theme.ts";

const ASR_OPTIONS: readonly { id: AsrProviderId; label: string; desc: string }[] = [
  { id: "doubao_free", label: "豆包流式(免Key)", desc: "内置免配置流式语音识别，按 v 直接说话" },
  { id: "plugin", label: "自定义插件", desc: "调用 ~/.config/rex-zero/asr-plugin 标准流插件" },
  { id: "openai", label: "OpenAI Whisper", desc: "需在5分钟扫码页导入 OpenAI API Key" },
  { id: "groq", label: "Groq Whisper", desc: "需在5分钟扫码页导入 Groq API Key" },
  { id: "elevenlabs", label: "ElevenLabs", desc: "需在5分钟扫码页导入 ElevenLabs Key" },
  { id: "doubao", label: "火山豆包API", desc: "需在5分钟扫码页导入火山 AppID 与 Key" },
];

const READER_MODES: readonly { id: ReaderViewMode; label: string }[] = [
  { id: "chat", label: "阅读模式" },
  { id: "raw", label: "终端模式" },
];

export type SettingsItem =
  | { id: "conn_ts"; label: string; value: string; valueColor: string; hint: string }
  | { id: "conn_ssh"; label: string; value: string; valueColor: string; hint: string }
  | { id: "conn_tcp"; label: string; value: string; valueColor: string; hint: string }
  | { id: "conn_pair"; label: string; value: string; valueColor: string; hint: string }
  | { id: "font"; label: string; value: string; valueColor: string; hint: string }
  | { id: "asr"; label: string; value: string; valueColor: string; hint: string }
  | { id: "reader"; label: string; value: string; valueColor: string; hint: string }
  | { id: "mute"; label: string; value: string; valueColor: string; hint: string }
  | { id: "host_row"; host: HostState; label: string; value: string; valueColor: string; hint: string };

export interface InlineConnPrompt {
  kind: "ssh" | "tcp";
  title: string;
  placeholder: string;
  text: string;
}

export function createSettingsController(fleet: Accessor<FleetSnapshot | null>) {
  const [prompt, setPrompt] = createSignal<InlineConnPrompt | null>(null);
  const [submitting, setSubmitting] = createSignal(false);

  const items = createMemo<SettingsItem[]>(() => {
    const f = fleet();
    const ts = f?.tailnet;
    const tsOnline = ts?.backendState === "Running";
    const tsVal = tsOnline ? `在线·${ts!.peers.length}台 ›` : ts?.enabled ? "连接中 ›" : "未开启 ›";

    const pair = f?.pair;
    const pairVal = pair?.active ? `PIN:${pair.pin} ›` : "生成配对码 ›";

    const fp = getFontPreset(f?.fontPreset);

    const asr = f?.asr;
    const curAsr = ASR_OPTIONS.find(o => o.id === asr?.provider) ?? ASR_OPTIONS[0]!;
    const asrReady = Boolean(asr?.configured);
    const asrVal = `< ${curAsr.label}${asrReady ? "" : "·未配"} >`;

    const rm = READER_MODES.find(m => m.id === (f?.readerMode ?? "chat")) ?? READER_MODES[0]!;
    const muted = f?.attention.muted ?? false;
    const imeStr = f?.ime.engine === "librime" ? "Rime词库" : "内置词库";

    const list: SettingsItem[] = [
      {
        id: "font",
        label: "全局字号与锐度",
        value: `< ${fp.label} >`,
        valueColor: THEME.amber,
        hint: "Z/C 或回车切换：全应用卡片、列表与阅读字号同步缩放",
      },
      {
        id: "asr",
        label: "语音输入引擎",
        value: asrVal,
        valueColor: asrReady ? THEME.green : THEME.rose,
        hint: curAsr.desc,
      },
      {
        id: "conn_ts",
        label: "+ Tailscale 组网直连",
        value: tsVal,
        valueColor: tsOnline ? THEME.cyan : THEME.amber,
        hint: "回车进入组网：扫码登录 Tailnet 并一键连接在线机器",
      },
      {
        id: "conn_ssh",
        label: "+ 添加 SSH 主机",
        value: "手输地址 ›",
        valueColor: THEME.cyan,
        hint: "回车直接输入 user@host[:port]（如 dev@192.168.1.10）",
      },
      {
        id: "conn_tcp",
        label: "+ 添加 TCP / HTTPS",
        value: "手输端点 ›",
        valueColor: THEME.cyan,
        hint: "回车输入局域网 ip:7297 或 https://host.ts.net",
      },
      {
        id: "conn_pair",
        label: "+ 5分钟手机扫码配对",
        value: pairVal,
        valueColor: pair?.active ? THEME.cyan : THEME.amber,
        hint: "手机扫码网页一次性导入多台主机、SSH私钥与云端语音Key",
      },
      {
        id: "reader",
        label: "默认对话视图",
        value: `< ${rm.label} >`,
        valueColor: THEME.text,
        hint: "进入对话详情时的默认阅读模式（详情内也可按 m 切换）",
      },
      {
        id: "mute",
        label: "提示音与输入法",
        value: `< ${muted ? "静音" : "开启"} · ${imeStr} >`,
        valueColor: muted ? THEME.dim : THEME.green,
        hint: "Z/C 或回车开关待审批/完成提示音；拼音词库自动就绪",
      },
    ];

    for (const h of f?.hosts ?? []) {
      if (h.id === "local" || h.id === "cp0") continue;
      const short = shortHostLabel(h.label, h.endpoint, h.id);
      const stTxt = h.phase === "live" ? "在线 (⏎重连)" : h.phase === "failed" ? "离线 (⏎重连)" : "连接中..";
      const stCol = h.phase === "live" ? THEME.green : h.phase === "failed" ? THEME.rose : THEME.amber;
      list.push({
        id: "host_row",
        host: h,
        label: `主机 · ${short}`,
        value: stTxt,
        valueColor: stCol,
        hint: h.problem ? `错误: ${h.problem} (BS×2移除)` : `${h.endpoint} (⏎重连 BS×2移除)`,
      });
    }
    return list;
  });

  const sel = createSelection(() => items().length, 0);

  const openInlinePrompt = (kind: "ssh" | "tcp") => {
    setPrompt(
      kind === "ssh"
        ? {
            kind: "ssh",
            title: "添加 SSH 主机 (自动走 ssh://)",
            placeholder: "例: dev@192.168.1.10 或 user@host:22",
            text: "",
          }
        : {
            kind: "tcp",
            title: "添加局域网 TCP / HTTPS 主机",
            placeholder: "例: 192.168.1.10:7297 或 https://mini.ts.net",
            text: "",
          },
    );
  };

  const submitPrompt = () => {
    const cur = prompt();
    if (!cur || submitting()) return;
    const raw = cur.text.trim();
    if (!raw) {
      setPrompt(null);
      return;
    }
    let endpoint = raw;
    if (!endpoint.includes("://")) {
      if (cur.kind === "ssh") {
        endpoint = `ssh://${endpoint}`;
      } else if (endpoint.endsWith(".ts.net")) {
        endpoint = `https://${endpoint}`;
      } else if (endpoint.includes(":")) {
        endpoint = `tcp://${endpoint}`;
      } else {
        endpoint = `tcp://${endpoint}:7297`;
      }
    }
    const submittedPrompt = cur;
    setSubmitting(true);
    void rexClient
      .dispatchAction({ op: "add_host", label: "", endpoint })
      .then(r => {
        if (!r.ok) {
          toast(r.error || "添加主机失败", "warn");
          return;
        }
        toast(`已添加并连接 ${endpoint}`, "ok");
        setPrompt(p => (p === submittedPrompt ? null : p));
      })
      .finally(() => setSubmitting(false));
  };

  const stepItem = (delta: -1 | 1 | 0) => {
    const item = items()[sel.index()];
    if (!item) return;
    const f = fleet();

    if (item.id === "conn_ts") {
      if (delta === 0 || delta === 1) navigateToSettings(0);
      return;
    }
    if (item.id === "conn_pair") {
      if (delta === 0 || delta === 1) navigateToSettings(1);
      return;
    }
    if (item.id === "conn_ssh") {
      if (delta === 0 || delta === 1) openInlinePrompt("ssh");
      return;
    }
    if (item.id === "conn_tcp") {
      if (delta === 0 || delta === 1) openInlinePrompt("tcp");
      return;
    }
    if (item.id === "font") {
      const step = delta === 0 ? 1 : delta;
      const cur = f?.fontPreset ?? 0;
      const next = (((cur + step) % FONT_PRESETS.length) + FONT_PRESETS.length) % FONT_PRESETS.length;
      void rexClient.dispatchAction({ op: "set_ui_prefs", fontPreset: next }).then(r => {
        if (r.ok) toast(`字号: ${getFontPreset(next).label}`, "ok");
      });
      return;
    }
    if (item.id === "asr") {
      const step = delta === 0 ? 1 : delta;
      const curIdx = Math.max(0, ASR_OPTIONS.findIndex(o => o.id === f?.asr.provider));
      const nextOpt = ASR_OPTIONS[(((curIdx + step) % ASR_OPTIONS.length) + ASR_OPTIONS.length) % ASR_OPTIONS.length]!;
      void rexClient.dispatchAction({ op: "asr_configure", provider: nextOpt.id, apiKey: "" }).then(r => {
        if (r.ok) toast(`语音引擎: ${nextOpt.label}`, "ok");
        else toast(r.error || "切换失败", "warn");
      });
      return;
    }
    if (item.id === "reader") {
      const step = delta === 0 ? 1 : delta;
      const curIdx = Math.max(0, READER_MODES.findIndex(m => m.id === (f?.readerMode ?? "chat")));
      const nextMode = READER_MODES[(((curIdx + step) % READER_MODES.length) + READER_MODES.length) % READER_MODES.length]!;
      void rexClient.dispatchAction({ op: "set_ui_prefs", readerMode: nextMode.id }).then(r => {
        if (r.ok) toast(`默认视图: ${nextMode.label}`, "ok");
      });
      return;
    }
    if (item.id === "mute") {
      const wasMuted = f?.attention.muted ?? false;
      void rexClient.dispatchAction({ op: "toggle_mute" }).then(r => {
        if (r.ok) toast(wasMuted ? "提示音已开启" : "提示音已静音", "ok");
      });
      return;
    }
    if (item.id === "host_row" && delta === 0) {
      const h = item.host;
      toast(`正在重连 ${h.label}...`, "dim");
      void rexClient.dispatchAction({ op: "add_host", label: h.label, endpoint: h.endpoint }).then(r => {
        toast(r.ok ? `已触发重连 ${h.label}` : (r.error || "重连失败"), r.ok ? "ok" : "warn");
      });
    }
  };

  return {
    items,
    sel,
    prompt,
    setPrompt,
    openInlinePrompt,
    submitPrompt,
    stepItem,
  };
}

const VISIBLE_ROWS = 5;
const ROW_H = 26;

export function SettingsTabView(props: {
  visible: Accessor<boolean>;
  ctrl: ReturnType<typeof createSettingsController>;
}): JSX.Element {
  const c = props.ctrl;
  const firstIdx = createMemo(() => {
    const idx = c.sel.index();
    let f = 0;
    if (idx >= VISIBLE_ROWS) f = idx - VISIBLE_ROWS + 1;
    return Math.max(0, Math.min(f, Math.max(0, c.items().length - VISIBLE_ROWS)));
  });
  const slice = createMemo(() => c.items().slice(firstIdx(), firstIdx() + VISIBLE_ROWS));
  const currentItem = () => c.items()[c.sel.index()] ?? null;

  return (
    <View
      class="absolute left-0 overflow-hidden"
      style={{
        insetT: 20,
        width: 320,
        height: 150,
        bgColor: THEME.bg,
        display: display(props.visible()),
      }}
    >
      <Index each={slice()}>
        {(item, localIdx) => {
          const absIdx = () => firstIdx() + localIdx;
          const selected = () => c.sel.index() === absIdx();
          const valW = () => Math.min(144, Math.ceil(measure(item().value, SLOT.xsBold)) + 4);
          return (
            <View
              class="absolute rounded-sm"
              style={{
                insetL: 2,
                insetT: 2 + localIdx * ROW_H,
                width: 314,
                height: ROW_H - 1,
                bgColor: selected() ? THEME.sel : THEME.bg,
                borderWidth: selected() ? 1 : 0,
                borderColor: selected() ? THEME.borderBright : THEME.bg,
              }}
            >
              <Show
                when={selected()}
                fallback={
                  <View class="absolute left-0 h-[1]" style={{ insetT: ROW_H - 2, width: 312, bgColor: THEME.line }} />
                }
              >
                <View class="absolute left-0 top-0 w-[2]" style={{ height: ROW_H - 2, bgColor: THEME.amber }} />
              </Show>

              <Text
                class="absolute text-sm leading-[24]"
                style={{ insetL: 8, insetT: 0, textColor: selected() ? THEME.text : THEME.muted }}
              >
                {ellipsize(item().label, SLOT.sm, 304 - valW() - 12)}
              </Text>
              <Text
                class="absolute text-xs font-bold leading-[24] text-right"
                style={{
                  insetL: 308 - valW(),
                  insetT: 0,
                  width: valW(),
                  textColor: item().valueColor,
                }}
              >
                {item().value}
              </Text>
            </View>
          );
        }}
      </Index>

      {/* Scrollbar */}
      <Show when={c.items().length > VISIBLE_ROWS}>
        <View class="absolute w-[2]" style={{ insetL: 318, insetT: 2, height: 128, bgColor: THEME.line }} />
        <View
          class="absolute w-[2]"
          style={{
            insetL: 318,
            insetT: 2 + Math.round((firstIdx() / Math.max(1, c.items().length)) * 128),
            height: Math.max(12, Math.round((VISIBLE_ROWS / c.items().length) * 128)),
            bgColor: THEME.dim,
          }}
        />
      </Show>

      {/* Bottom 18px Contextual Hint Strip */}
      <View class="absolute left-0 w-[320] h-[18]" style={{ insetT: 132, bgColor: THEME.panel }}>
        <View class="absolute left-0 top-0 w-[320] h-[1]" style={{ bgColor: THEME.line }} />
        <Text class="absolute text-xs leading-[17]" style={{ insetL: 6, insetT: 1, textColor: THEME.dim }}>
          {ellipsize(currentItem()?.hint ?? "F/X上下选择  Z/C切换值  ⏎确认", SLOT.xs, 308)}
        </Text>
      </View>

      {/* Inline SSH / TCP Connection Input Dialog */}
      <Show when={c.prompt()}>
        {p => (
          <View class="absolute left-0 top-0 w-[320] h-[150] bg-[#000000dc] z-40">
            <View
              class="absolute rounded-md border"
              style={{ insetL: 8, insetT: 22, width: 304, height: 96, bgColor: THEME.modal, borderColor: THEME.amber }}
            >
              <Text class="absolute text-sm font-bold leading-[18]" style={{ insetL: 8, insetT: 6, textColor: THEME.amber }}>
                {p().title}
              </Text>
              <View
                class="absolute border"
                style={{ insetL: 8, insetT: 30, width: 286, height: 28, bgColor: THEME.bg, borderColor: THEME.cyan }}
              >
                <Text
                  class="absolute text-sm leading-[26]"
                  style={{ insetL: 6, insetT: 0, textColor: p().text ? THEME.text : THEME.dim }}
                >
                  {ellipsize(p().text ? `${p().text}|` : p().placeholder, SLOT.sm, 274)}
                </Text>
              </View>
              <Text class="absolute text-xs leading-[16]" style={{ insetL: 8, insetT: 66, textColor: THEME.muted }}>
                ⏎ 立即保存并连接    Esc 取消返回
              </Text>
            </View>
          </View>
        )}
      </Show>
    </View>
  );
}
