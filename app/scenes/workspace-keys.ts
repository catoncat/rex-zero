// Scoped keyboard & navigation handlers for `Workspace` (`阅读` vs直连 `终端` PTY + safe `设置 (s)`).

import type { Accessor } from "solid-js";
import type { KeyHandler, NavHandler, Selection } from "@pocketjs/framework/compact/primitives";
import type { ApprovalOption } from "../types.ts";
import {
  isAltKey,
  isCtrlKey,
  isCtrlSpace,
  isCtrlTab,
  isPrintableChar,
  jumpToNextPending,
  rexClient,
} from "../client.ts";
import { openHelp, toast } from "../frame.tsx";
import type { ReaderViewMode } from "../theme.ts";
import { DETAIL_HELP } from "./workspace-menus.ts";

export interface WorkspaceKeyActions {
  paneKey: Accessor<string>;
  viewMode: Accessor<ReaderViewMode>;
  composerOpen: Accessor<boolean>;
  quickKeyOpen: Accessor<boolean>;
  settingsOpen: Accessor<boolean>;
  setSettingsOpen: (v: boolean) => void;
  setQuickKeyOpen: (v: boolean) => void;
  settingsSel: Selection;
  stepSetting: (delta: -1 | 1 | 0) => void;
  toggleViewMode: () => void;
  stepFontPreset: (delta?: number) => void;
  openComposer: (opts?: { seed?: string; mode?: "en" | "ime"; autoAsr?: boolean }) => void;
  leaveToParent: () => void;
  scrollDoc: (delta: number) => void;
  pageStep: () => number;
  jumpToBottom: () => void;
  setDocScroll: (v: number) => void;
  setStickBottom: (v: boolean) => void;
  visibleApprovalOptions: Accessor<ApprovalOption[]>;
  dispatchApproval: (idx: number) => boolean;
  sendPtyRaw: (data: string) => void;
  sendPtyKey: (keyName: string, mods?: number) => void;
}

export function createWorkspaceKeyHandler(act: WorkspaceKeyActions): { onKey: KeyHandler; onNav: NavHandler } {
  const onKey: KeyHandler = event => {
    if (rexClient.quickSwitchOpen() || act.composerOpen() || act.quickKeyOpen()) return;

    if (act.settingsOpen()) {
      if (event.kind !== "key") return true;
      if (!event.pressed) return event.key !== "Shift";
      const k = event.key;
      if (k === "Escape" || k === "Backspace" || k === "s" || k === "S" || isAltKey(k, "s")) {
        act.setSettingsOpen(false);
        return true;
      }
      if (k === "ArrowUp" || k === "f" || k === "F") {
        act.settingsSel.move(-1, true);
        return true;
      }
      if (k === "ArrowDown" || k === "x" || k === "X") {
        act.settingsSel.move(1, true);
        return true;
      }
      if (k === "ArrowLeft" || k === "z" || k === "Z") {
        act.stepSetting(-1);
        return true;
      }
      if (k === "ArrowRight" || k === "c" || k === "C" || k === "Enter" || k === " ") {
        act.stepSetting(k === "Enter" ? 0 : 1);
        return true;
      }
      return true;
    }

    // MODE 2: `终端` (`raw`) — Real Direct-Input PTY Terminal!
    if (act.viewMode() === "raw") {
      if (event.kind === "commit") {
        if (event.text) act.sendPtyRaw(event.text);
        return true;
      }
      if (event.kind !== "key") return;
      const k = event.key;

      if (isAltKey(k, "n") || isCtrlTab(k)) return false;
      if (!event.pressed) return k !== "Shift";

      if (isAltKey(k, "m") || isCtrlKey(k, "t") || k === "F1") {
        act.toggleViewMode();
        return true;
      }
      if (isAltKey(k, "p") || isCtrlSpace(k) || k === "F2") {
        act.openComposer({ mode: "ime" });
        return true;
      }
      if (isAltKey(k, "v") || k === "F3") {
        act.openComposer({ mode: "ime", autoAsr: true });
        return true;
      }
      if (isAltKey(k, "s") || k === "F4") {
        act.setSettingsOpen(true);
        return true;
      }
      if (isAltKey(k, "t")) {
        act.stepFontPreset(1);
        return true;
      }
      if (isAltKey(k, "k") || isCtrlKey(k, "k")) {
        act.setQuickKeyOpen(true);
        return true;
      }
      if (isAltKey(k, "h") || k === "Help") {
        openHelp("终端与阅读按键说明", DETAIL_HELP);
        return true;
      }
      if (k === "Alt+Backspace" || k === "Alt+Escape" || isAltKey(k, "q")) {
        act.leaveToParent();
        return true;
      }
      if (k === "PageUp" || isAltKey(k, "f")) {
        act.scrollDoc(-act.pageStep());
        return true;
      }
      if (k === "PageDown" || isAltKey(k, "x")) {
        act.scrollDoc(act.pageStep());
        return true;
      }
      if (isAltKey(k, "b")) {
        act.jumpToBottom();
        return true;
      }
      if (k === "Alt+Tab") {
        rexClient.setQuickSwitchOpen(true);
        return true;
      }

      if (k === "Enter") {
        act.sendPtyRaw("\r");
        return true;
      }
      if (k === "Backspace") {
        act.sendPtyRaw("\x7f");
        return true;
      }
      if (k === "Tab") {
        act.sendPtyRaw("\t");
        return true;
      }
      if (k === "Shift+Tab") {
        act.sendPtyKey("Tab", 1);
        return true;
      }
      if (k === "Escape") {
        act.sendPtyKey("Escape", 0);
        return true;
      }
      if (isPrintableChar(k)) {
        act.sendPtyRaw(k);
        return true;
      }
      if (
        k === "ArrowUp" ||
        k === "ArrowDown" ||
        k === "ArrowLeft" ||
        k === "ArrowRight" ||
        k === "Home" ||
        k === "End" ||
        k === "Delete" ||
        k === "Insert" ||
        k.startsWith("Control+") ||
        k.startsWith("Ctrl+") ||
        k.startsWith("Alt+") ||
        k.startsWith("Shift+")
      ) {
        act.sendPtyKey(k, 0);
        return true;
      }
      return true;
    }

    // MODE 1: `阅读` (`chat`) — Clean Reader + Single-Key Shortcuts
    if (event.kind !== "key") return;
    const k = event.key;

    if (isAltKey(k, "n") || isCtrlKey(k, "n") || isCtrlTab(k)) return false;
    if (!event.pressed) return;

    if (isCtrlKey(k, "t") || isAltKey(k, "m") || k === "F1") {
      act.toggleViewMode();
      return true;
    }
    if (isCtrlKey(k, "k") || isAltKey(k, "k")) {
      act.setQuickKeyOpen(true);
      return true;
    }
    if (isCtrlKey(k, "r") || isAltKey(k, "v")) {
      act.openComposer({ mode: "ime", autoAsr: true });
      return true;
    }
    if (isCtrlSpace(k) || isAltKey(k, "p")) {
      act.openComposer({ mode: "ime" });
      return true;
    }
    if (isCtrlKey(k, "c")) {
      void rexClient.dispatchAction({ op: "send_key", key: act.paneKey(), keyName: "c", mods: 2 }).then(r => {
        toast(r.ok ? "已向远端发送 Ctrl+C" : (r.error || "发送失败"), r.ok ? "ok" : "warn");
      });
      return true;
    }

    if (k === "?" || k === "h" || k === "H") {
      openHelp("对话界面按键说明", DETAIL_HELP);
      return true;
    }
    if (k === "PageUp") {
      act.scrollDoc(-act.pageStep());
      return true;
    }
    if (k === "PageDown") {
      act.scrollDoc(act.pageStep());
      return true;
    }
    if (k === "End") {
      act.jumpToBottom();
      return true;
    }
    if (k === "Home") {
      act.setDocScroll(0);
      act.setStickBottom(false);
      return true;
    }

    const visibleOpts = act.visibleApprovalOptions();
    if (visibleOpts.length > 0) {
      const kLower = k.toLowerCase();
      const exactIdx = visibleOpts.findIndex(o => o.key && o.key.toLowerCase() === kLower);
      if (exactIdx >= 0 && act.dispatchApproval(exactIdx)) return true;
      if (k.length === 1 && k >= "1" && k <= "4") {
        const idx = k.charCodeAt(0) - 49;
        if (idx < visibleOpts.length && act.dispatchApproval(idx)) return true;
      }
      if (k === "Enter" && act.dispatchApproval(0)) return true;
    }

    if (k === "m" || k === "M") act.toggleViewMode();
    else if (k === "t" || k === "T") act.stepFontPreset(1);
    else if (k === "s" || k === "S") act.setSettingsOpen(true);
    else if (k === "b" || k === "B") act.jumpToBottom();
    else if (k === "k" || k === "K") act.setQuickKeyOpen(true);
    else if (k === "Enter" || k === "i" || k === "I") act.openComposer({ mode: "en" });
    else if (k === "p" || k === "P") act.openComposer({ mode: "ime" });
    else if (k === "v" || k === "V") act.openComposer({ mode: "ime", autoAsr: true });
    else if (k === "/") act.openComposer({ seed: "/", mode: "en" });
    else if (k === "n" || k === "N") jumpToNextPending();
    else if (k === "Tab") rexClient.setQuickSwitchOpen(true);
    else return false;
    return true;
  };

  const onNav: NavHandler = event => {
    if (
      rexClient.quickSwitchOpen() ||
      act.composerOpen() ||
      act.quickKeyOpen() ||
      act.settingsOpen() ||
      act.viewMode() === "raw"
    ) {
      return;
    }
    if (event.key === "up") act.scrollDoc(event.fine ? -6 : -3);
    else if (event.key === "down") act.scrollDoc(event.fine ? 6 : 3);
    else if (event.key === "left") act.scrollDoc(-act.pageStep());
    else if (event.key === "right") act.scrollDoc(act.pageStep());
    else if (event.key === "pause") act.scrollDoc(event.fine ? -act.pageStep() : act.pageStep());
    else return false;
    return true;
  };

  return { onKey, onNav };
}
