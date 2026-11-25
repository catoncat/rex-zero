// Scene 2 (Detail, 320x170 pure black):
// Strictly TWO real-time modes:
//   1. `阅读` (`chat`): Crisp human-centered conversation view (`F/X` scroll, `⏎/p/v` Composer, `⌫` back).
//   2. `终端` (`raw`): Real interactive PTY terminal — type commands directly without opening a dialog!

import { Show, createEffect, createMemo, createSignal, onCleanup, untrack, type JSX } from "solid-js";
import { View } from "@pocketjs/framework/components";
import { createSelection } from "@pocketjs/framework/compact/primitives";
import { primaryPaneTitle, rexClient, shortHostLabel, statusMeta } from "../client.ts";
import { toast, useKey, useNav, useSceneActive, useScenes, type SceneDef } from "../frame.tsx";
import { FONT_PRESETS, THEME, getFontPreset, type ReaderViewMode } from "../theme.ts";
import { ComposerDrawer } from "./composer.tsx";
import { QuickKeyModal } from "./quick_switch.tsx";
import { buildReaderDoc, buildTerminalDoc, cleanOptionLabel, layoutApprovalBanner } from "./reader-layout.ts";
import { createWorkspaceKeyHandler } from "./workspace-keys.ts";
import {
  buildWorkspaceQuickKeys,
  buildWorkspaceSettingRows,
  stepWorkspaceSettingRow,
} from "./workspace-menus.ts";
import {
  VT_COLS,
  WS_BODY_WITH_HUD_H,
  WS_FULL_BODY_H,
  WS_HUD_H,
  WorkspaceBottomHud,
  WorkspaceDocBody,
  WorkspaceSettingsModal,
  WorkspaceTopBar,
  type WorkspaceHeaderInfo,
} from "./workspace-view.tsx";

const DOC_TEXT_W = 304;

export function createWorkspaceScene(): SceneDef {
  return {
    title: "对话详情",
    render: () => <WorkspaceView />,
  };
}

function normalizeTwoModes(m: string | undefined): ReaderViewMode {
  return m === "raw" ? "raw" : "chat";
}

function WorkspaceView(): JSX.Element {
  const scenes = useScenes();
  const active = useSceneActive();

  const [viewMode, setViewMode] = createSignal<ReaderViewMode>(
    normalizeTwoModes(rexClient.fleet()?.readerMode),
  );
  const [fontPresetIdx, setFontPresetIdx] = createSignal<number>(rexClient.fleet()?.fontPreset ?? 0);
  const [composerOpen, setComposerOpen] = createSignal(false);
  const [composerHeight, setComposerHeight] = createSignal(0);
  const [composerSeed, setComposerSeed] = createSignal("");
  const [composerMode, setComposerMode] = createSignal<"en" | "ime">("en");
  const [composerAutoAsr, setComposerAutoAsr] = createSignal(false);
  const [quickKeyOpen, setQuickKeyOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [docScroll, setDocScroll] = createSignal(0);
  const [stickBottom, setStickBottom] = createSignal(true);

  let markedSeenKey = "";
  let markingSeenKey = "";
  let lastPaneKey = "";
  let lastSyncedServerPreset: number | undefined = rexClient.fleet()?.fontPreset;
  let pendingPresetWrites = 0;
  let ptyChain: Promise<void> = Promise.resolve();

  onCleanup(() => rexClient.setIsTyping(false));

  createEffect(() => {
    const srvPreset = rexClient.fleet()?.fontPreset;
    if (srvPreset === undefined || srvPreset === lastSyncedServerPreset) return;
    lastSyncedServerPreset = srvPreset;
    if (pendingPresetWrites === 0 && srvPreset !== untrack(fontPresetIdx)) {
      setFontPresetIdx(srvPreset);
    }
  });

  const fontSpec = createMemo(() => getFontPreset(fontPresetIdx()));
  const paneKey = () => rexClient.activePaneKey() ?? "";
  const pane = () => rexClient.paneView();
  const paneSummary = createMemo(() => rexClient.fleet()?.panes.find(p => p.key === paneKey()) ?? null);

  const hasDraft = () => {
    const k = paneKey();
    if (!k) return false;
    return rexClient.getDraft(k).length > 0 || !!(paneSummary()?.hasDraft);
  };

  createEffect(() => {
    const k = paneKey();
    if (k && k !== lastPaneKey) {
      lastPaneKey = k;
      setViewMode(normalizeTwoModes(rexClient.fleet()?.readerMode));
      setComposerOpen(false);
      setQuickKeyOpen(false);
      setSettingsOpen(false);
      setStickBottom(true);
      setDocScroll(0);
    }
  });

  createEffect(() => {
    const isActive = active();
    const k = paneKey();
    const st = pane()?.status ?? paneSummary()?.status;
    if (markedSeenKey !== "" && markedSeenKey !== k) markedSeenKey = "";
    if (st !== "unseen_done") {
      if (markedSeenKey === k) markedSeenKey = "";
      return;
    }
    if (!isActive || !k || markedSeenKey === k || markingSeenKey === k) return;
    markingSeenKey = k;
    void rexClient
      .dispatchAction({ op: "mark_seen", key: k })
      .then(r => {
        if (r.ok && paneKey() === k && (pane()?.status ?? paneSummary()?.status) === "unseen_done") {
          markedSeenKey = k;
        }
      })
      .finally(() => {
        if (markingSeenKey === k) markingSeenKey = "";
      });
  });

  const leaveToParent = () => {
    scenes.pop();
  };

  const toggleViewMode = (forceMode?: ReaderViewMode) => {
    const next: ReaderViewMode = forceMode ?? (viewMode() === "chat" ? "raw" : "chat");
    setViewMode(next);
    setStickBottom(true);
    toast(
      next === "raw" ? "终端模式 (直接打字输命令，Alt+M 切回阅读)" : "阅读模式 (F/X 滚屏，⏎ 回复)",
      "ok",
    );
  };

  const stepFontPreset = (delta = 1) => {
    const len = FONT_PRESETS.length;
    const next = (((fontPresetIdx() + delta) % len) + len) % len;
    setFontPresetIdx(next);
    toast(`字号: ${getFontPreset(next).label}`, "ok");
    pendingPresetWrites++;
    void rexClient
      .dispatchAction({ op: "set_ui_prefs", fontPreset: next })
      .then(r => {
        if (r.ok) lastSyncedServerPreset = next;
      })
      .finally(() => {
        pendingPresetWrites = Math.max(0, pendingPresetWrites - 1);
      });
  };

  const visibleApprovalOptions = createMemo(() => {
    if (composerOpen() || settingsOpen() || quickKeyOpen() || viewMode() === "raw") return [];
    return pane()?.approval?.options.slice(0, 4) ?? [];
  });

  const approvalLayout = createMemo(() =>
    composerOpen() || settingsOpen() || quickKeyOpen() || viewMode() === "raw"
      ? null
      : layoutApprovalBanner(pane()?.approval, visibleApprovalOptions()),
  );

  const showHud = () => !composerOpen();
  const hudReserve = () => (showHud() ? WS_HUD_H : 0);
  const composerReserve = () => (composerOpen() ? Math.max(60, composerHeight()) + 1 : 0);
  const bodyH = () => {
    const appH = approvalLayout()?.height ?? 0;
    const avail = composerOpen() ? WS_FULL_BODY_H - composerReserve() : WS_BODY_WITH_HUD_H;
    return Math.max(28, avail - (appH > 0 ? appH + 2 : 0));
  };

  createEffect(() => {
    if (viewMode() === "raw") {
      rexClient.setVtDims(VT_COLS, Math.max(6, Math.floor(bodyH() / 13)));
    }
  });

  const visualLines = createMemo(() => {
    const p = pane();
    const spec = fontSpec();
    if (viewMode() === "raw") {
      return buildTerminalDoc(p?.vt, p?.rawLines, spec.slot, DOC_TEXT_W, true);
    }
    const st = p?.status ?? paneSummary()?.status;
    return buildReaderDoc(p?.readerMessages ?? [], spec.slot, DOC_TEXT_W, st, p?.liveActivityText).lines;
  });

  const lineH = () => fontSpec().lineH;
  const visibleLinesCount = () => Math.max(1, Math.floor(bodyH() / lineH()));
  const maxDocScroll = () => Math.max(0, visualLines().length - visibleLinesCount());

  createEffect(() => {
    const max = maxDocScroll();
    if (stickBottom()) setDocScroll(max);
    else if (docScroll() > max) setDocScroll(max);
  });

  const scrollDoc = (delta: number) => {
    const max = maxDocScroll();
    if (max <= 0) {
      toast("当前内容只有 1 页", "dim");
      return;
    }
    const next = Math.max(0, Math.min(max, docScroll() + delta));
    setDocScroll(next);
    setStickBottom(next >= max);
  };

  const pageStep = () => Math.max(2, visibleLinesCount() - 1);

  const jumpToBottom = () => {
    setStickBottom(true);
    setDocScroll(maxDocScroll());
    toast("已回到底部", "dim");
  };

  const openComposer = (opts?: { seed?: string; mode?: "en" | "ime"; autoAsr?: boolean }) => {
    setComposerSeed(opts?.seed ?? "");
    setComposerMode(opts?.mode ?? "en");
    setComposerAutoAsr(opts?.autoAsr ?? false);
    setStickBottom(true);
    setComposerOpen(true);
  };

  const sendPtyRaw = (data: string) => {
    const k = paneKey();
    if (!k || !data) return;
    setStickBottom(true);
    ptyChain = ptyChain.then(async () => {
      const r = await rexClient.dispatchAction({ op: "send_input", key: k, data });
      if (!r.ok && r.error) toast(r.error, "warn");
      rexClient.refreshPane();
    });
  };

  const sendPtyKey = (keyName: string, mods = 0) => {
    const k = paneKey();
    if (!k) return;
    setStickBottom(true);
    ptyChain = ptyChain.then(async () => {
      const r = await rexClient.dispatchAction({ op: "send_key", key: k, keyName, mods });
      if (!r.ok && r.error) toast(r.error, "warn");
      rexClient.refreshPane();
    });
  };

  const sendRemoteEsc = () => {
    const k = paneKey();
    if (!k) return;
    void rexClient.dispatchAction({ op: "send_key", key: k, keyName: "Escape", mods: 0 }).then(r => {
      toast(r.ok ? "已向远端发送 Esc" : (r.error || "发送失败"), r.ok ? "ok" : "warn");
    });
  };

  const dispatchApproval = (idx: number): boolean => {
    const opt = visibleApprovalOptions()[idx];
    if (!opt?.send) return false;
    void rexClient.dispatchAction({ op: "send_input", key: paneKey(), data: opt.send }).then(r => {
      toast(r.ok ? `已选: ${cleanOptionLabel(opt.key, opt.label)}` : (r.error || "发送失败"), r.ok ? "ok" : "warn");
    });
    return true;
  };

  const settingRows = createMemo(() => buildWorkspaceSettingRows(viewMode(), fontSpec()));
  const settingsSel = createSelection(() => settingRows().length, 0);

  const stepSetting = (delta: -1 | 1 | 0) => {
    const row = settingRows()[settingsSel.index()];
    if (!row) return;
    stepWorkspaceSettingRow(row.id, delta, {
      toggleViewMode: () => toggleViewMode(),
      stepFontPreset: step => stepFontPreset(step),
    });
  };

  const quickKeyItems = createMemo(() =>
    buildWorkspaceQuickKeys({
      paneKey: paneKey(),
      pane: pane(),
      isActive: active,
      currentPaneKey: paneKey,
      scenes,
      sendRemoteEsc,
    }),
  );

  const { onKey, onNav } = createWorkspaceKeyHandler({
    paneKey,
    viewMode,
    composerOpen,
    quickKeyOpen,
    settingsOpen,
    setSettingsOpen,
    setQuickKeyOpen,
    settingsSel,
    stepSetting,
    toggleViewMode,
    stepFontPreset,
    openComposer,
    leaveToParent,
    scrollDoc,
    pageStep,
    jumpToBottom,
    setDocScroll,
    setStickBottom,
    visibleApprovalOptions,
    dispatchApproval,
    sendPtyRaw,
    sendPtyKey,
  });

  useKey(onKey);
  useNav(onNav);

  const shownLines = createMemo(() => {
    const start = docScroll();
    return visualLines().slice(start, start + visibleLinesCount());
  });

  const scrolledUp = () => docScroll() < maxDocScroll();

  const headerInfo = createMemo<WorkspaceHeaderInfo>(() => {
    const p = pane();
    const s = paneSummary();
    const st = p?.status ?? s?.status ?? "idle";
    const dotColor = statusMeta(st).color;
    const hostRaw = p?.hostLabel ?? s?.hostLabel ?? "";
    const hostShort = hostRaw ? shortHostLabel(hostRaw, undefined, s?.hostId) : "";
    const taskTitle = s
      ? primaryPaneTitle(s)
      : p
        ? primaryPaneTitle({
            windowLabel: p.windowLabel ?? "",
            title: p.title,
            sessionLabel: p.sessionLabel,
            program: p.program,
            pwd: p.pwd,
          })
        : "连接中...";
    const fullTitle = hostShort ? `${hostShort} · ${taskTitle}` : taskTitle;

    const totalLines = Math.max(1, visualLines().length);
    const vis = visibleLinesCount();
    const totalPages = Math.max(1, Math.ceil(totalLines / vis));
    const curPage = !scrolledUp()
      ? totalPages
      : Math.min(totalPages, Math.max(1, Math.ceil((docScroll() + vis) / vis)));
    const upArrow = scrolledUp() ? "↑" : "";
    const modeName = viewMode() === "raw" ? "终端" : "阅读";
    const pageText = `${upArrow}${modeName} ${curPage}/${totalPages}`;
    const pageColor = scrolledUp() ? THEME.cyan : viewMode() === "raw" ? THEME.amber : THEME.muted;

    let liveBadge = "";
    let liveColor: string = THEME.green;
    if (p?.streamPhase === "reconnecting") {
      liveBadge = "重连中";
      liveColor = THEME.amber;
    } else if (p?.streamPhase === "failed") {
      liveBadge = "已断流";
      liveColor = THEME.rose;
    } else if (st === "blocked") {
      liveBadge = "待确认";
      liveColor = THEME.amber;
    } else if (st === "running") {
      liveBadge = "运行中";
      liveColor = THEME.green;
    } else if (hasDraft()) {
      liveBadge = "草稿";
      liveColor = THEME.amber;
    }

    return { dotColor, fullTitle, pageText, pageColor, liveBadge, liveColor };
  });

  return (
    <View class="absolute left-0 top-0 w-[320] h-[170]" style={{ bgColor: THEME.bg }}>
      <WorkspaceTopBar info={headerInfo} />

      <WorkspaceDocBody
        paneLoaded={() => Boolean(pane())}
        mode={viewMode}
        fontSpec={fontSpec}
        bodyH={bodyH}
        hudReserve={hudReserve}
        composerReserve={composerReserve}
        shownLines={shownLines}
        totalLines={() => visualLines().length}
        visibleLineCount={visibleLinesCount}
        scrollOffset={docScroll}
        maxScroll={maxDocScroll}
        approvalLayout={approvalLayout}
      />

      <Show when={showHud()}>
        <WorkspaceBottomHud mode={viewMode} scrolledUp={scrolledUp} />
      </Show>

      <Show when={composerOpen()}>
        <ComposerDrawer
          paneKey={paneKey}
          initialSeed={composerSeed}
          initialMode={composerMode}
          autoStartAsr={composerAutoAsr}
          onScrollContext={delta => scrollDoc(delta)}
          onClose={() => {
            setComposerOpen(false);
            setComposerHeight(0);
          }}
          onSent={() => {
            setStickBottom(true);
            rexClient.refreshPane();
          }}
          onHeightChange={h => setComposerHeight(h)}
        />
      </Show>

      <Show when={settingsOpen()}>
        <WorkspaceSettingsModal rows={settingRows} selectedIndex={settingsSel.index} />
      </Show>

      <Show when={quickKeyOpen()}>
        <QuickKeyModal items={quickKeyItems()} onClose={() => setQuickKeyOpen(false)} />
      </Show>
    </View>
  );
}
