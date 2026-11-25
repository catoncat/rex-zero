// Keyboard handler for `ComposerDrawer`: EN / librime Pinyin / Doubao ASR + `Fn+F/X/Z/C` multi-line cursor editing.

import type { Accessor } from "solid-js";
import type { KeyHandler, Slot } from "@pocketjs/framework/compact/primitives";
import {
  isAltKey,
  isCtrlKey,
  isCtrlSpace,
  isCtrlTab,
  isPrintableChar,
  rexClient,
} from "../client.ts";
import { toast } from "../frame.tsx";
import { moveCursorVertical, type DraftCursorLayout } from "./composer-editor.ts";
import type { createComposerController } from "./composer-logic.ts";

const CN_PUNCT: Record<string, string> = {
  ",": "，",
  ".": "。",
  "?": "？",
  "!": "！",
  ":": "：",
  "(": "（",
  ")": "）",
  "[": "「",
  "]": "」",
};

export interface ComposerKeyDeps {
  ctrl: ReturnType<typeof createComposerController>;
  paneKey: Accessor<string>;
  asrRecording: Accessor<boolean>;
  asrBusy: Accessor<boolean>;
  draftLayout: Accessor<DraftCursorLayout>;
  inputSlot: Accessor<Slot>;
  cycleInputMethod: () => void;
  onScrollContext?: (delta: number) => void;
}

export function createComposerKeyHandler(deps: ComposerKeyDeps): KeyHandler {
  let preferredVertX: number | null = null;
  const { ctrl } = deps;

  return event => {
    if (rexClient.quickSwitchOpen()) return;
    const isLocked = ctrl.sending();

    if (event.kind === "commit") {
      if (isLocked || deps.asrRecording()) return true;
      if (event.text) {
        preferredVertX = null;
        ctrl.insertText(event.text);
      }
      return true;
    }
    if (event.kind !== "key") return;
    const k = event.key;

    if (isAltKey(k, "n") || isCtrlKey(k, "n") || isCtrlTab(k)) {
      if (event.pressed && !isLocked) ctrl.flushSave(false);
      return false;
    }

    if (!event.pressed) return k !== "Shift";

    if (isLocked) {
      if (k === "Escape") {
        ctrl.closeOnce();
      } else if (rexClient.isUnconfirmedSend(deps.paneKey())) {
        if (isCtrlKey(k, "u")) {
          rexClient.resolveUnconfirmedSend(deps.paneKey(), "discard");
        } else if (isCtrlKey(k, "e")) {
          rexClient.resolveUnconfirmedSend(deps.paneKey(), "restore");
        }
      }
      return true;
    }

    if (deps.asrRecording()) {
      if (k === "Escape") {
        void rexClient.dispatchAction({ op: "asr_cancel" });
        toast("已取消录音", "dim");
        return true;
      }
      if (k === "Enter" || k === " " || k === "v" || k === "V" || isAltKey(k, "v") || isCtrlKey(k, "r")) {
        void rexClient.dispatchAction({ op: "asr_toggle", key: deps.paneKey() }).then(r => {
          if (!r.ok && r.error) toast(r.error, "warn");
        });
        return true;
      }
      return true;
    }

    if (deps.asrBusy()) {
      if (k === "Escape") {
        void rexClient.dispatchAction({ op: "asr_cancel" });
        return true;
      }
      return true;
    }

    if (isCtrlSpace(k)) {
      const next = !ctrl.imeMode();
      ctrl.setImeMode(next);
      ctrl.invalidatePreviewIme();
      const pendingRaw = ctrl.getRimeRawNow();
      if (!next && pendingRaw.length > 0) {
        ctrl.setRimeRaw("");
        ctrl.setImeReply(null);
        ctrl.insertText(pendingRaw);
      }
      return true;
    }

    if (isCtrlKey(k, "r") || isAltKey(k, "v")) {
      ctrl.flushSave(false);
      void rexClient.dispatchAction({ op: "asr_toggle", key: deps.paneKey() }).then(r => {
        if (!r.ok && r.error) toast(r.error, "warn");
      });
      return true;
    }

    if (isCtrlKey(k, "u")) {
      preferredVertX = null;
      ctrl.invalidateAllIme();
      ctrl.setRimeRaw("");
      ctrl.setImeReply(null);
      ctrl.updateDraft("", deps.paneKey(), 0);
      return true;
    }

    if (k === "Tab") {
      const raw = ctrl.getRimeRawNow();
      if (ctrl.imeMode() && raw.length > 0) {
        ctrl.enqueuePreviewCompose({ raw, toggleSchema: true });
      } else {
        deps.cycleInputMethod();
      }
      return true;
    }

    if (ctrl.imeMode()) {
      const raw = ctrl.getRimeRawNow();
      if (raw.length > 0) {
        if (k === "Escape") {
          ctrl.invalidatePreviewIme();
          ctrl.setRimeRaw("");
          ctrl.setImeReply(null);
          return true;
        }
        if (k === "Backspace") {
          const nextRaw = raw.slice(0, -1);
          ctrl.setRimeRaw(nextRaw);
          if (nextRaw.length === 0) {
            ctrl.invalidatePreviewIme();
            ctrl.setImeReply(null);
          } else {
            ctrl.enqueuePreviewCompose({ raw: nextRaw });
          }
          return true;
        }
        if (k === "Enter") {
          preferredVertX = null;
          ctrl.invalidatePreviewIme();
          ctrl.setRimeRaw("");
          ctrl.setImeReply(null);
          ctrl.insertText(raw);
          return true;
        }
        if (k === " " || (k.length === 1 && k >= "1" && k <= "5")) {
          preferredVertX = null;
          const idx = k === " " ? 0 : k.charCodeAt(0) - 49;
          ctrl.enqueueCommitCompose(raw, idx);
          return true;
        }
        if (k === "-" || k === "," || k === "[" || k === "PageUp" || k === "ArrowLeft") {
          ctrl.enqueuePreviewCompose({ raw, pageDelta: -1 });
          return true;
        }
        if (k === "=" || k === "." || k === "]" || k === "PageDown" || k === "ArrowRight") {
          ctrl.enqueuePreviewCompose({ raw, pageDelta: 1 });
          return true;
        }
        if (k.length === 1 && ((k >= "a" && k <= "z") || k === "'")) {
          const nextRaw = raw + k;
          ctrl.setRimeRaw(nextRaw);
          ctrl.enqueuePreviewCompose({ raw: nextRaw });
          return true;
        }
        if (isPrintableChar(k)) {
          preferredVertX = null;
          const punct = CN_PUNCT[k] ?? k;
          ctrl.enqueueCommitCompose(raw, 0, punct);
          return true;
        }
        return true;
      } else if (k.length === 1 && k >= "a" && k <= "z") {
        ctrl.setRimeRaw(k);
        ctrl.enqueuePreviewCompose({ raw: k });
        return true;
      }
    }

    // Cursor navigation across multi-line draft (`Fn+F/X/Z/C` = `ArrowUp/Down/Left/Right`, `Home/End`)
    if (k === "ArrowLeft") {
      preferredVertX = null;
      ctrl.setCursor(ctrl.cursor() - 1);
      return true;
    }
    if (k === "ArrowRight") {
      preferredVertX = null;
      ctrl.setCursor(ctrl.cursor() + 1);
      return true;
    }
    if (k === "Home" || isCtrlKey(k, "a")) {
      preferredVertX = null;
      ctrl.setCursor(0);
      return true;
    }
    if (k === "End" || isCtrlKey(k, "e")) {
      preferredVertX = null;
      ctrl.setCursor(deps.draftLayout().totalChars);
      return true;
    }
    if (k === "ArrowUp") {
      const moved = moveCursorVertical(ctrl.draft(), deps.draftLayout(), -1, deps.inputSlot(), preferredVertX);
      if (moved.movedRow) {
        preferredVertX = moved.targetX;
        ctrl.setCursor(moved.cursor);
      } else {
        deps.onScrollContext?.(-2);
      }
      return true;
    }
    if (k === "ArrowDown") {
      const moved = moveCursorVertical(ctrl.draft(), deps.draftLayout(), 1, deps.inputSlot(), preferredVertX);
      if (moved.movedRow) {
        preferredVertX = moved.targetX;
        ctrl.setCursor(moved.cursor);
      } else {
        deps.onScrollContext?.(2);
      }
      return true;
    }
    if (k === "PageUp") {
      deps.onScrollContext?.(-5);
      return true;
    }
    if (k === "PageDown") {
      deps.onScrollContext?.(5);
      return true;
    }

    if (k === "Escape") {
      ctrl.invalidatePreviewIme();
      ctrl.flushSave(true);
      ctrl.closeOnce();
      return true;
    }
    if (k === "Enter") {
      void ctrl.sendMessage();
      return true;
    }
    if (k === "Backspace") {
      preferredVertX = null;
      ctrl.deleteChar("back");
      return true;
    }
    if (k === "Delete") {
      preferredVertX = null;
      ctrl.deleteChar("forward");
      return true;
    }
    if (isPrintableChar(k)) {
      preferredVertX = null;
      const outChar = ctrl.imeMode() ? (CN_PUNCT[k] ?? k) : k;
      ctrl.insertText(outChar);
      return true;
    }

    return true;
  };
}
