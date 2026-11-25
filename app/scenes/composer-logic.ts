// Serialized IME composition, codepoint-accurate cursor editing, per-pane draft persistence,
// and locked submission state machine for `ComposerDrawer`.

import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import { after } from "@pocketjs/framework/clock";
import type { ImeComposeReply } from "../types.ts";
import { rexClient } from "../client.ts";
import { toast } from "../frame.tsx";
import { clampCursor, deleteAtCursor, insertAtCursor } from "./composer-editor.ts";

let imeChain: Promise<void> = Promise.resolve();
const imeEpochs = new Map<string, number>();
const failedImeByPane = new Set<string>();
const imePendingOpsByPane = new Map<string, number>();

function getImeEpoch(key: string): number {
  return imeEpochs.get(key) ?? 0;
}

function bumpImeEpoch(key: string): void {
  if (!key) return;
  imeEpochs.set(key, getImeEpoch(key) + 1);
  failedImeByPane.delete(key);
}

function getImePendingOps(key: string): number {
  return imePendingOpsByPane.get(key) ?? 0;
}

function adjustImePendingOps(key: string, delta: number): void {
  if (!key) return;
  const next = (imePendingOpsByPane.get(key) ?? 0) + delta;
  if (next <= 0) imePendingOpsByPane.delete(key);
  else imePendingOpsByPane.set(key, next);
}

export interface ComposerControllerOptions {
  paneKey: Accessor<string>;
  initialSeed: Accessor<string>;
  initialMode: Accessor<"en" | "ime">;
  autoStartAsr: Accessor<boolean>;
  onClose: () => void;
  onSent: () => void;
}

export function createComposerController(opts: ComposerControllerOptions) {
  const initialKey = opts.paneKey();
  const initialPending = rexClient.getPendingSend(initialKey);
  const seed = initialPending === null ? opts.initialSeed() : "";
  const deferInitialSeed = seed.length > 0 && getImePendingOps(initialKey) > 0;
  const initialText =
    initialPending !== null
      ? initialPending
      : deferInitialSeed
        ? rexClient.getDraft(initialKey)
        : rexClient.getDraft(initialKey) + seed;
  if (seed.length > 0 && !deferInitialSeed) {
    rexClient.setLocalDraft(initialKey, initialText, { dirty: true });
  }

  const initialLen = Array.from(initialText).length;
  const [draft, setDraftSignal] = createSignal<string>(initialText);
  const [cursor, setCursorSignal] = createSignal<number>(initialLen);
  const [imeMode, setImeMode] = createSignal<boolean>(opts.initialMode() === "ime");
  const [rimeRaw, setRimeRawSignal] = createSignal<string>("");
  const [imeReply, setImeReply] = createSignal<ImeComposeReply | null>(null);
  const [caretOn, setCaretOn] = createSignal(true);

  const sending = () => rexClient.isSending(opts.paneKey());

  let draftRef = initialText;
  let cursorRef = initialLen;
  let rimeRawRef = "";
  let saveTimer: (() => void) | null = null;
  let lastBoundKey = initialKey;
  let lastExternalSeq = rexClient.externalDraftSeq(initialKey);
  let wasSendingOnBoundKey = initialPending !== null;
  let closed = false;
  let alive = true;
  let imePreviewSeq = 0;

  const closeOnce = () => {
    if (closed) return;
    closed = true;
    opts.onClose();
  };

  const setCursor = (next: number) => {
    const clamped = clampCursor(draftRef, next);
    cursorRef = clamped;
    setCursorSignal(clamped);
    setCaretOn(true);
  };

  const setDraft = (next: string, nextCursor?: number) => {
    draftRef = next;
    setDraftSignal(next);
    const targetCur = nextCursor !== undefined ? nextCursor : cursorRef;
    const clamped = clampCursor(next, targetCur);
    cursorRef = clamped;
    setCursorSignal(clamped);
    setCaretOn(true);
  };

  const setRimeRaw = (next: string) => {
    rimeRawRef = next;
    setRimeRawSignal(next);
  };

  const getRimeRawNow = () => rimeRawRef;

  const cancelSaveTimer = () => {
    saveTimer?.();
    saveTimer = null;
  };

  const invalidateAllIme = (key = opts.paneKey()) => {
    bumpImeEpoch(key);
    imePreviewSeq++;
  };

  const invalidatePreviewIme = () => {
    imePreviewSeq++;
  };

  const tickCaret = () => {
    if (!alive) return;
    setCaretOn(v => !v);
    after(0.5, tickCaret);
  };
  const stopCaret = after(0.5, tickCaret);

  onCleanup(() => {
    alive = false;
    invalidatePreviewIme();
    stopCaret();
    cancelSaveTimer();
    rexClient.setIsTyping(false);
  });

  rexClient.setIsTyping(true);

  const persistDraft = (targetKey: string, snapshotText: string, notifyOnError: boolean) => {
    if (
      !targetKey ||
      rexClient.isSending(targetKey) ||
      snapshotText === rexClient.getLastQueuedSaveTarget(targetKey)
    ) {
      return;
    }
    void rexClient.saveDraft(targetKey, snapshotText).then(r => {
      if (!r.ok && notifyOnError) {
        toast(r.error || "草稿同步失败(已本地暂存)", "warn");
      }
    });
  };

  const scheduleSave = () => {
    const targetKey = opts.paneKey();
    if (rexClient.isSending(targetKey)) return;
    cancelSaveTimer();
    saveTimer = after(0.35, () => {
      if (!alive || opts.paneKey() !== targetKey || rexClient.isSending(targetKey)) return;
      const latest = untrack(() => rexClient.getDraft(targetKey));
      persistDraft(targetKey, latest, false);
    });
  };

  const flushSave = (notifyOnError = false) => {
    cancelSaveTimer();
    const targetKey = opts.paneKey();
    if (rexClient.isSending(targetKey)) return;
    persistDraft(targetKey, draftRef, notifyOnError);
  };

  createEffect(() => {
    const k = opts.paneKey();
    if (k !== lastBoundKey) {
      lastBoundKey = k;
      invalidatePreviewIme();
      cancelSaveTimer();
      setRimeRaw("");
      setImeReply(null);
      const pending = rexClient.getPendingSend(k);
      wasSendingOnBoundKey = pending !== null;
      const nextText = pending !== null ? pending : rexClient.getDraft(k);
      setDraft(nextText, Array.from(nextText).length);
      lastExternalSeq = rexClient.externalDraftSeq(k);
    }
  });

  createEffect(() => {
    const k = opts.paneKey();
    const seq = rexClient.externalDraftSeq(k);
    if (seq !== lastExternalSeq) {
      lastExternalSeq = seq;
      if (rexClient.isSending(k)) return;
      cancelSaveTimer();
      const prevLen = Array.from(draftRef).length;
      const nextText = rexClient.getDraft(k);
      const nextLen = Array.from(nextText).length;
      setDraft(nextText, nextLen);
      if (nextLen > prevLen && prevLen > 0) {
        toast(`语音已追加 (共 ${nextLen} 字，Fn+方向键可回看修改)`, "ok");
      }
    }
  });

  createEffect(() => {
    const k = opts.paneKey();
    if (k !== lastBoundKey || rexClient.isSending(k)) return;
    const storeDraft = rexClient.getDraft(k);
    if (storeDraft !== draftRef) {
      const prevLen = Array.from(draftRef).length;
      const nextLen = Array.from(storeDraft).length;
      setDraft(storeDraft, nextLen >= prevLen ? nextLen : cursorRef);
    }
  });

  createEffect(() => {
    const k = opts.paneKey();
    const pending = rexClient.getPendingSend(k);
    const nowSending = pending !== null;
    if (nowSending) {
      if (pending !== draftRef) setDraft(pending, Array.from(pending).length);
    } else if (wasSendingOnBoundKey) {
      const settled = rexClient.getDraft(k);
      setDraft(settled, Array.from(settled).length);
      if (settled === "" && rimeRawRef === "") {
        opts.onSent();
        closeOnce();
      }
    }
    wasSendingOnBoundKey = nowSending;
  });

  if (seed.length > 0 && !deferInitialSeed) {
    scheduleSave();
  }

  if (initialPending === null && opts.autoStartAsr()) {
    void rexClient.dispatchAction({ op: "asr_toggle", key: opts.paneKey() }).then(r => {
      if (!r.ok && r.error) toast(r.error, "warn");
    });
  }

  const updateDraft = (next: string, targetKey = opts.paneKey(), nextCursor?: number) => {
    if (!rexClient.isSending(targetKey)) {
      rexClient.setLocalDraft(targetKey, next, { dirty: true });
    }
    if (alive && opts.paneKey() === targetKey) {
      setDraft(next, nextCursor);
      if (!rexClient.isSending(targetKey)) scheduleSave();
    } else if (!rexClient.isSending(targetKey)) {
      void rexClient.saveDraft(targetKey, next);
    }
  };

  const applyCursorEdit = (
    mutate: (cur: string, curPos: number) => { text: string; cursor: number },
  ) => {
    const opKey = opts.paneKey();
    if (getImePendingOps(opKey) > 0) {
      const epoch = getImeEpoch(opKey);
      adjustImePendingOps(opKey, 1);
      imeChain = imeChain.then(() => {
        try {
          if (getImeEpoch(opKey) !== epoch) return;
          if (rexClient.isSending(opKey)) {
            rexClient.updatePendingSend(opKey, prev => mutate(prev, Array.from(prev).length).text);
            return;
          }
          const base = untrack(() => rexClient.getDraft(opKey));
          const res = mutate(base, cursorRef);
          updateDraft(res.text, opKey, res.cursor);
        } finally {
          adjustImePendingOps(opKey, -1);
        }
      });
    } else {
      const res = mutate(draftRef, cursorRef);
      updateDraft(res.text, opKey, res.cursor);
    }
  };

  const insertText = (txt: string) => {
    if (!txt) return;
    applyCursorEdit((cur, pos) => insertAtCursor(cur, pos, txt));
  };

  const deleteChar = (dir: "back" | "forward") => {
    applyCursorEdit((cur, pos) => deleteAtCursor(cur, pos, dir));
  };

  if (deferInitialSeed) {
    insertText(seed);
  }

  const enqueuePreviewCompose = (req: { raw: string; pageDelta?: number; toggleSchema?: boolean }) => {
    const reqKey = opts.paneKey();
    const epoch = getImeEpoch(reqKey);
    const pSeq = ++imePreviewSeq;
    imeChain = imeChain.then(async () => {
      if (!alive || getImeEpoch(reqKey) !== epoch || pSeq !== imePreviewSeq || opts.paneKey() !== reqKey) return;
      if (rexClient.isSending(reqKey)) return;
      const reply = await rexClient.dispatchAction({
        op: "ime_compose",
        raw: req.raw,
        pageDelta: req.pageDelta,
        toggleSchema: req.toggleSchema,
      });
      if (!alive || getImeEpoch(reqKey) !== epoch || pSeq !== imePreviewSeq || opts.paneKey() !== reqKey) return;
      if (rexClient.isSending(reqKey)) return;
      if (!reply.ok || !reply.ime) {
        if (reply.error) toast(reply.error, "warn");
        return;
      }
      const ime = reply.ime;
      if (ime.committed && ime.committed.length > 0) {
        const base = untrack(() => rexClient.getDraft(reqKey));
        const res = insertAtCursor(base, cursorRef, ime.committed);
        updateDraft(res.text, reqKey, res.cursor);
      }
      setRimeRaw(ime.raw);
      setImeReply(ime.raw.length > 0 ? ime : null);
      if (req.toggleSchema) {
        toast(ime.schema === "double_pinyin" ? "已切至双拼" : "已切至全拼", "ok");
      }
    });
  };

  const enqueueCommitCompose = (raw: string, selectIdx: number, trailingSuffix = "") => {
    const opKey = opts.paneKey();
    const epoch = getImeEpoch(opKey);
    invalidatePreviewIme();
    setRimeRaw("");
    setImeReply(null);
    adjustImePendingOps(opKey, 1);

    const handleCommitFailure = (errMsg?: string | null) => {
      const preserveTail = raw + trailingSuffix;
      if (rexClient.isSending(opKey)) {
        failedImeByPane.add(opKey);
        if (preserveTail.length > 0) rexClient.updatePendingSend(opKey, prev => prev + preserveTail);
      } else if (preserveTail.length > 0) {
        const base = untrack(() => rexClient.getDraft(opKey));
        const res = insertAtCursor(base, cursorRef, preserveTail);
        updateDraft(res.text, opKey, res.cursor);
      }
      toast(errMsg || "拼音上屏失败", "warn");
    };

    imeChain = imeChain.then(async () => {
      try {
        if (getImeEpoch(opKey) !== epoch) return;
        const reply = await rexClient.dispatchAction({ op: "ime_compose", raw, selectIdx });
        if (getImeEpoch(opKey) !== epoch) return;
        if (!reply.ok || !reply.ime) {
          handleCommitFailure(reply.error);
          return;
        }
        const ime = reply.ime;
        const hasCommitted = Boolean(ime.committed && ime.committed.length > 0);
        const committed = hasCommitted
          ? ime.committed!
          : trailingSuffix
            ? ime.candidates[0] || raw
            : "";
        const unconsumedTail = ime.raw && (hasCommitted || !trailingSuffix) ? ime.raw : "";

        if (rexClient.isSending(opKey)) {
          const addition = committed + unconsumedTail + trailingSuffix;
          if (addition.length > 0) rexClient.updatePendingSend(opKey, prev => prev + addition);
          return;
        }

        const base = untrack(() => rexClient.getDraft(opKey));
        if (trailingSuffix.length > 0) {
          const addition = committed + unconsumedTail + trailingSuffix;
          if (addition.length > 0) {
            const res = insertAtCursor(base, cursorRef, addition);
            updateDraft(res.text, opKey, res.cursor);
          }
        } else {
          let curBase = base;
          let curPos = cursorRef;
          if (committed.length > 0) {
            const res = insertAtCursor(curBase, curPos, committed);
            curBase = res.text;
            curPos = res.cursor;
            updateDraft(curBase, opKey, curPos);
          }
          if (unconsumedTail.length > 0) {
            if (alive && opts.paneKey() === opKey && untrack(imeMode)) {
              const combined = unconsumedTail + rimeRawRef;
              setRimeRaw(combined);
              if (combined === unconsumedTail) setImeReply(ime);
              else enqueuePreviewCompose({ raw: combined });
            } else {
              const res = insertAtCursor(curBase, curPos, unconsumedTail);
              updateDraft(res.text, opKey, res.cursor);
            }
          }
        }
      } catch {
        if (getImeEpoch(opKey) === epoch) handleCommitFailure("拼音上屏失败");
      } finally {
        adjustImePendingOps(opKey, -1);
      }
    });
  };

  const sendMessage = async () => {
    const targetKey = opts.paneKey();
    if (!targetKey || rexClient.isSending(targetKey)) return;

    const submitEpoch = getImeEpoch(targetKey);
    failedImeByPane.delete(targetKey);
    const pendingRawAtSubmit = rimeRawRef;
    const hasQueuedIme = getImePendingOps(targetKey) > 0;
    if (pendingRawAtSubmit.length > 0) {
      invalidatePreviewIme();
      setRimeRaw("");
      setImeReply(null);
      if (hasQueuedIme) insertText(pendingRawAtSubmit);
    }
    const initialSnapshot = hasQueuedIme
      ? draftRef
      : insertAtCursor(draftRef, cursorRef, pendingRawAtSubmit).text;
    if (!rexClient.beginPendingSend(targetKey, initialSnapshot)) return;
    cancelSaveTimer();

    try {
      const imeTimedOut = await Promise.race([
        imeChain.then(() => false),
        new Promise<boolean>(resolve => {
          after(0.6, () => resolve(true));
        }),
      ]);
      if (imeTimedOut && getImePendingOps(targetKey) > 0) {
        invalidateAllIme(targetKey);
        toast("输入法上屏超时，草稿已保留，请再按回车", "warn");
      }
      if (failedImeByPane.has(targetKey) || getImeEpoch(targetKey) !== submitEpoch) {
        failedImeByPane.delete(targetKey);
        const restored = rexClient.getFailedSendRestore(targetKey) ?? initialSnapshot;
        rexClient.setLocalDraft(targetKey, restored, { dirty: true });
        if (alive && opts.paneKey() === targetKey) {
          setDraft(restored, Array.from(restored).length);
          scheduleSave();
        } else {
          void rexClient.saveDraft(targetKey, restored);
        }
        return;
      }

      const finalPayload = rexClient.getPendingSend(targetKey) ?? initialSnapshot;
      if (finalPayload.trim().length === 0) {
        toast("请输入内容或按 Alt+V 语音输入", "dim");
        return;
      }

      const r = await rexClient.sendInput(targetKey, `${finalPayload}\r`, true);
      if (!r.ok) {
        if (!r.unconfirmed) {
          const curDraft = rexClient.getDraft(targetKey);
          if (alive && opts.paneKey() === targetKey) setDraft(curDraft, Array.from(curDraft).length);
        }
        toast(r.error || "发送失败(草稿已保留)", "warn");
        return;
      }

      if (r.draftCleared === false) {
        const remaining = rexClient.getDraft(targetKey);
        if (alive && opts.paneKey() === targetKey) {
          setDraft(remaining, Array.from(remaining).length);
          toast("已发送，新增草稿已保留", "ok");
        }
        return;
      }

      if (r.persistError) {
        toast("已发送(本地草稿清理失败)", "warn");
      } else {
        toast("已发送", "ok");
      }
      if (alive && opts.paneKey() === targetKey) {
        setDraft("", 0);
        opts.onSent();
        closeOnce();
      }
    } finally {
      rexClient.endPendingSend(targetKey);
    }
  };

  return {
    draft,
    cursor,
    setCursor,
    imeMode,
    setImeMode,
    rimeRaw,
    setRimeRaw,
     getRimeRawNow,
    imeReply,
    setImeReply,
    caretOn,
    sending,
    closeOnce,
    flushSave,
    invalidateAllIme,
    invalidatePreviewIme,
    updateDraft,
    insertText,
    deleteChar,
    enqueuePreviewCompose,
    enqueueCommitCompose,
    sendMessage,
  };
}
