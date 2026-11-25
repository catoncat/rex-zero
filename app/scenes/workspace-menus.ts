// Menu builders & safe in-conversation Settings toggles for Scene 2 (`Workspace`).

import type { AsrProviderId, PaneViewPayload } from "../types.ts";
import { rexClient } from "../client.ts";
import { confirm, toast, type HelpRow, type Scenes } from "../frame.tsx";
import { THEME, type FontPresetSpec, type ReaderViewMode } from "../theme.ts";
import type { QuickKeyItem } from "./quick_switch.tsx";
import type { WorkspaceSettingRow } from "./workspace-view.tsx";

export const ASR_QUICK_LIST: readonly { id: AsrProviderId; label: string }[] = [
  { id: "doubao_free", label: "豆包免Key" },
  { id: "plugin", label: "自定义插件" },
  { id: "openai", label: "OpenAI" },
  { id: "groq", label: "Groq" },
  { id: "elevenlabs", label: "ElevenLabs" },
  { id: "doubao", label: "火山API" },
];

export const DETAIL_HELP: readonly HelpRow[] = [
  { keys: "阅读: F/X Z/C", desc: "上下滚屏 / 整页翻页 (b 回到底部)" },
  { keys: "阅读: ⏎ p v", desc: "英文回复 / 拼音输入 / 豆包语音" },
  { keys: "阅读: m t s ⌫", desc: "切终端 / 切字号 / 设置 / 回列表" },
  { keys: "终端: 直接打字", desc: "字符·回车·⌫·Tab·ESC·Fn方向直连PTY" },
  { keys: "终端: Alt+M/P/V", desc: "切回阅读 / 拼音入终端 / 语音入终端" },
  { keys: "终端: Fn+L/M ⌫", desc: "翻看终端历史 / Alt+⌫ 返回对话列表" },
];

/** Strictly safe preference toggles — NO destructive remote interrupt actions on Left/Right arrow! */
export function buildWorkspaceSettingRows(
  viewMode: ReaderViewMode,
  fontSpec: FontPresetSpec,
): WorkspaceSettingRow[] {
  const f = rexClient.fleet();
  const asr = f?.asr;
  const curAsr = ASR_QUICK_LIST.find(o => o.id === asr?.provider) ?? ASR_QUICK_LIST[0]!;
  const muted = f?.attention.muted ?? false;
  return [
    {
      id: "mode",
      label: "当前视图 (m / Alt+M)",
      value: `< ${viewMode === "chat" ? "阅读模式" : "终端模式"} >`,
      valueColor: THEME.cyan,
    },
    {
      id: "font",
      label: "字体大小 (t / Alt+T)",
      value: `< ${fontSpec.label} >`,
      valueColor: THEME.amber,
    },
    {
      id: "asr",
      label: "语音引擎",
      value: `< ${curAsr.label} >`,
      valueColor: asr?.configured ? THEME.green : THEME.amber,
    },
    {
      id: "mute",
      label: "完成提示音",
      value: `< ${muted ? "静音" : "开启"} >`,
      valueColor: muted ? THEME.dim : THEME.green,
    },
  ];
}

export function stepWorkspaceSettingRow(
  rowId: string,
  delta: -1 | 1 | 0,
  actions: {
    toggleViewMode: () => void;
    stepFontPreset: (step: number) => void;
  },
): void {
  const step = delta === 0 ? 1 : delta;
  if (rowId === "mode") {
    actions.toggleViewMode();
  } else if (rowId === "font") {
    actions.stepFontPreset(step);
  } else if (rowId === "asr") {
    const curId = rexClient.fleet()?.asr.provider;
    const idx = Math.max(0, ASR_QUICK_LIST.findIndex(o => o.id === curId));
    const next =
      ASR_QUICK_LIST[(((idx + step) % ASR_QUICK_LIST.length) + ASR_QUICK_LIST.length) % ASR_QUICK_LIST.length]!;
    void rexClient.dispatchAction({ op: "asr_configure", provider: next.id, apiKey: "" }).then(r => {
      if (r.ok) toast(`语音引擎: ${next.label}`, "ok");
    });
  } else if (rowId === "mute") {
    const wasMuted = rexClient.fleet()?.attention.muted ?? false;
    void rexClient.dispatchAction({ op: "toggle_mute" }).then(r => {
      if (r.ok) toast(wasMuted ? "提示音已开启" : "提示音已静音", "ok");
    });
  }
}

export function buildWorkspaceQuickKeys(opts: {
  paneKey: string;
  pane: PaneViewPayload | null;
  isActive: () => boolean;
  currentPaneKey: () => string;
  scenes: Scenes;
  sendRemoteEsc: () => void;
}): QuickKeyItem[] {
  const { paneKey: k, pane: p } = opts;
  const sendSeq = (data: string, msg: string) => () => {
    void rexClient.dispatchAction({ op: "send_input", key: k, data }).then(r => {
      toast(r.ok ? msg : (r.error || "发送失败"), r.ok ? "ok" : "warn");
    });
  };
  return [
    { id: "k1", keyHint: "1", label: "1+回车", accent: true, run: sendSeq("1\r", "已发送 1+回车") },
    { id: "k2", keyHint: "2", label: "2+回车", run: sendSeq("2\r", "已发送 2+回车") },
    { id: "yes", keyHint: "3", label: "y+回车", accent: true, run: sendSeq("y\r", "已发送 y+回车") },
    { id: "no", keyHint: "4", label: "n+回车", run: sendSeq("n\r", "已发送 n+回车") },
    { id: "enter", keyHint: "5", label: "发回车", run: sendSeq("\r", "已发送 回车") },
    { id: "esc", keyHint: "6", label: "发Esc中断", accent: true, run: () => opts.sendRemoteEsc() },
    {
      id: "ctrl_c",
      keyHint: "7",
      label: "Ctrl+C",
      danger: true,
      run: () => {
        void rexClient.dispatchAction({ op: "send_key", key: k, keyName: "c", mods: 2 }).then(r => {
          toast(r.ok ? "已发送 Ctrl+C" : (r.error || "发送失败"), r.ok ? "ok" : "warn");
        });
      },
    },
    {
      id: "tab_key",
      keyHint: "8",
      label: "发Tab键",
      run: () => {
        void rexClient.dispatchAction({ op: "send_key", key: k, keyName: "Tab", mods: 0 }).then(r => {
          toast(r.ok ? "已向远端发送 Tab" : (r.error || "发送失败"), r.ok ? "ok" : "warn");
        });
      },
    },
    {
      id: "close",
      keyHint: "9",
      label: "关闭当前窗格",
      danger: true,
      run: () => {
        const closingKey = k;
        void confirm({
          title: "关闭窗格",
          text: `确定关闭 ${p?.windowLabel || p?.title || "当前窗格"} 吗？`,
          action: "关闭",
          danger: true,
        }).then(ok => {
          if (!ok) return;
          void rexClient.dispatchAction({ op: "close_block", key: closingKey }).then(r => {
            if (!r.ok) toast(r.error || "关闭失败", "warn");
            else {
              toast("已关闭窗格", "ok");
              if (opts.isActive() && opts.currentPaneKey() === closingKey) opts.scenes.pop();
            }
          });
        });
      },
    },
  ];
}
