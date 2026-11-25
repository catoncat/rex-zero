// Top-level Rex Zero SolidJS store, long-poll loops, and public API assembly.

import { createEffect, createSignal, untrack, type Accessor } from "solid-js";
import { after } from "@pocketjs/framework/clock";
import type { ActionReply, FleetSnapshot, PaneViewPayload, RexAction } from "../types.ts";
import type { LocalDraftEntry } from "./reconcile.ts";
import {
  BACKOFF_S,
  WAIT_HTTP_TIMEOUT_MS,
  WAIT_TIMEOUT_MS,
  createRingHttp,
  type RawHttpTransport,
} from "./ring-http.ts";
import { createSaveDraft } from "./save-draft.ts";
import { createSendInput } from "./send-input.ts";
import { createSnapshotSync } from "./snapshot-sync.ts";
import { createWatermarks } from "./watermarks.ts";

export { splitForWireCall } from "./chunking.ts";
export {
  reconcileServerDraftUpdate,
  type LocalDraftEntry,
  type ReconcileDraftInput,
  type ReconcileDraftResult,
} from "./reconcile.ts";
export type { RawHttpTransport } from "./ring-http.ts";
export {
  findMatchingHost,
  formatRelativeAge,
  isAltKey,
  isCtrlKey,
  isCtrlSpace,
  isCtrlTab,
  isGenericWindowLabel,
  isPrintableChar,
  isRexPeerNode,
  isShellPromptTitle,
  jumpToNextPending,
  navigateToPane,
  navigateToSettings,
  primaryPaneTitle,
  registerNavHandlers,
  sanitizeDisplayText,
  secondaryPaneSubtitle,
  shortHostLabel,
  shortenPwd,
  sortPanesByPriority,
  statusMeta,
  wrapCjk,
  type StatusMeta,
} from "./ui-helpers.ts";

export interface RexClient {
  fleet: Accessor<FleetSnapshot | null>;
  nowMs: Accessor<number>;
  connected: Accessor<boolean>;
  lastError: Accessor<string>;
  activePaneKey: Accessor<string | null>;
  setActivePaneKey: (key: string | null) => void;
  paneView: Accessor<PaneViewPayload | null>;
  vtDims: Accessor<{ cols: number; rows: number }>;
  setVtDims: (cols: number, rows: number) => void;
  mruKeys: Accessor<string[]>;
  recordVisit: (key: string) => void;
  quickSwitchOpen: Accessor<boolean>;
  setQuickSwitchOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  isTyping: Accessor<boolean>;
  setIsTyping: (v: boolean) => void;
  getDraft: (key: string) => string;
  setLocalDraft: (key: string, text: string, opts?: { dirty?: boolean; baseServerText?: string }) => void;
  externalDraftSeq: (key: string) => number;
  isSending: (key: string) => boolean;
  isUnconfirmedSend: (key: string) => boolean;
  resolveUnconfirmedSend: (key: string, action: "discard" | "restore") => void;
  getPendingSend: (key: string) => string | null;
  getFailedSendRestore: (key: string) => string | null;
  beginPendingSend: (key: string, text: string) => boolean;
  updatePendingSend: (key: string, next: string | ((prev: string) => string)) => void;
  endPendingSend: (key: string) => void;
  getLastQueuedSaveTarget: (key: string) => string | undefined;
  saveDraft: (key: string, fullText: string) => Promise<ActionReply>;
  sendInput: (key: string, data: string, clearDraft?: boolean) => Promise<ActionReply>;
  start: () => void;
  refreshPane: () => void;
  dispatchAction: (action: RexAction) => Promise<ActionReply>;
  quitApp: () => void;
}

let nextClientInstanceSeq = 0;

export function createRexClient(customHttp?: RawHttpTransport): RexClient {
  const clientId = `c${Date.now().toString(36)}${(++nextClientInstanceSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let http: RawHttpTransport | null = customHttp ?? null;
  const ensureHttp = () => (http ??= createRingHttp());

  const [fleet, setFleet] = createSignal<FleetSnapshot | null>(null);
  const [nowMs, setNowMs] = createSignal<number>(Date.now());
  const [connected, setConnected] = createSignal<boolean>(false);
  const [lastError, setLastError] = createSignal<string>("");
  const [activePaneKey, setActivePaneKeyRaw] = createSignal<string | null>(null);
  const [paneView, setPaneView] = createSignal<PaneViewPayload | null>(null);
  const [vtDims, setVtDimsSignal] = createSignal({ cols: 53, rows: 10 });
  const [mruKeys, setMruKeys] = createSignal<string[]>([]);
  const [quickSwitchOpen, setQuickSwitchOpen] = createSignal<boolean>(false);
  const [isTyping, setIsTyping] = createSignal<boolean>(false);
  const [paneRefreshTick, setPaneRefreshTick] = createSignal<number>(0);

  const [localDrafts, setLocalDrafts] = createSignal<Record<string, LocalDraftEntry>>({});
  const [externalDraftSeqs, setExternalDraftSeqs] = createSignal<Record<string, number>>({});
  const [pendingSends, setPendingSends] = createSignal<Record<string, string>>({});
  const [unconfirmedSends, setUnconfirmedSends] = createSignal<Record<string, boolean>>({});

  const hasOwn = (obj: Record<string, unknown>, key: string) =>
    Boolean(key) && Object.prototype.hasOwnProperty.call(obj, key);
  const isSending = (key: string): boolean => hasOwn(pendingSends(), key);
  const isUnconfirmedSend = (key: string): boolean => Boolean(key) && Boolean(unconfirmedSends()[key]);
  const refreshPane = () => setPaneRefreshTick(n => n + 1);

  const wm = createWatermarks({ clientId, fleet, localDrafts, setLocalDrafts });

  const dropKey = <T,>(setter: (fn: (prev: Record<string, T>) => Record<string, T>) => void, key: string) =>
    setter(prev => {
      if (!hasOwn(prev, key)) return prev;
      const copy = { ...prev };
      delete copy[key];
      return copy;
    });

  const clearSendSessionState = (key: string): void => {
    wm.activeSendSessions.delete(key);
    dropKey(setUnconfirmedSends, key);
    dropKey(setPendingSends, key);
  };

  const captureSendPreconditions = (key: string) =>
    wm.needsKeyBootRebase(key)
      ? { lockedDraftVer: 0, lockedBootId: wm.st.lastRetiredBootId ?? wm.st.activeEngineBootId }
      : { lockedDraftVer: wm.getKnownServerDraftVer(key), lockedBootId: wm.st.activeEngineBootId };

  let saverRef!: ReturnType<typeof createSaveDraft>;
  let senderRef!: ReturnType<typeof createSendInput>;

  const snapSync = createSnapshotSync({
    wm,
    setFleet,
    activePaneKey,
    setConnected,
    setLastError,
    setLocalDrafts,
    setExternalDraftSeqs,
    triggerSaveDraft: (k, t) => {
      if (!isSending(k) && !wm.activeSendSessions.has(k)) void saverRef.saveDraft(k, t);
    },
    onSettledUnconfirmedSends: () => senderRef.settleResolvedUnconfirmedSends(),
  });

  saverRef = createSaveDraft({
    clientId,
    ensureHttp,
    wm,
    snapSync,
    localDrafts,
    setExternalDraftSeqs,
    isSending,
  });

  senderRef = createSendInput({
    clientId,
    ensureHttp,
    wm,
    snapSync,
    postRawActionDetailed: saverRef.postRawActionDetailed,
    saveDraft: saverRef.saveDraft,
    localDrafts,
    setPendingSends,
    setUnconfirmedSends,
    clearSendSessionState,
    captureSendPreconditions,
    activePaneKey,
    refreshPane,
  });

  const getDraft = (key: string): string => {
    if (!key) return "";
    const local = localDrafts();
    return hasOwn(local, key) ? local[key]!.text : (fleet()?.drafts[key] ?? "");
  };

  const getLastQueuedSaveTarget = (key: string): string | undefined => {
    if (!key || wm.failedSaveKeys.has(key)) return undefined;
    if (wm.lastQueuedSaveTarget.has(key)) return wm.lastQueuedSaveTarget.get(key);
    return wm.st.prevServerDrafts[key] ?? untrack(() => fleet()?.drafts[key]) ?? "";
  };

  const beginPendingSend = (key: string, value: string): boolean => {
    if (!key || wm.activeSendSessions.has(key) || hasOwn(untrack(() => pendingSends()), key)) return false;
    const pre = captureSendPreconditions(key);
    wm.activeSendSessions.set(key, {
      pendingText: value,
      lockedDraftVer: pre.lockedDraftVer,
      lockedBootId: pre.lockedBootId,
      extChanged: false,
      unsentExternal: "",
      ownedByComposer: true,
    });
    setPendingSends(prev => ({ ...prev, [key]: value }));
    return true;
  };

  const updatePendingSend = (key: string, next: string | ((prev: string) => string)): void => {
    const sess = key ? wm.activeSendSessions.get(key) : undefined;
    if (!sess || !sess.ownedByComposer || sess.unconfirmedWriteSeq !== undefined) return;
    const resolved = typeof next === "function" ? next(sess.pendingText) : next;
    if (resolved !== sess.pendingText) {
      sess.pendingText = resolved;
      setPendingSends(prev => (hasOwn(prev, key) ? { ...prev, [key]: resolved } : prev));
    }
  };

  const endPendingSend = (key: string): void => {
    const sess = key ? wm.activeSendSessions.get(key) : undefined;
    if (!key || sess?.unconfirmedWriteSeq !== undefined) return;
    if (sess?.ownedByComposer) wm.activeSendSessions.delete(key);
    dropKey(setPendingSends, key);
  };

  const getPendingSend = (key: string): string | null => {
    const map = pendingSends();
    return hasOwn(map, key) ? map[key]! : null;
  };

  const getFailedSendRestore = (key: string): string | null => {
    const sess = key ? wm.activeSendSessions.get(key) : undefined;
    return sess ? sess.pendingText + sess.unsentExternal : null;
  };

  const setVtDims = (cols: number, rows: number) => {
    const c = Math.max(20, Math.min(120, Math.floor(cols)));
    const r = Math.max(4, Math.min(40, Math.floor(rows)));
    const prev = untrack(() => vtDims());
    if (prev.cols !== c || prev.rows !== r) setVtDimsSignal({ cols: c, rows: r });
  };

  const recordVisit = (key: string) => {
    if (key) setMruKeys(prev => [key, ...prev.filter(k => k !== key)].slice(0, 16));
  };

  let started = false;
  let effectInstalled = false;
  let paneFetchInFlight = false;
  let paneFetchDirty = false;
  let paneFetchSeq = 0;

  const setActivePaneKey = (key: string | null) => {
    const prev = untrack(() => activePaneKey());
    if (key === prev) return;
    paneFetchSeq++;
    setActivePaneKeyRaw(key);
    if (key === null) {
      paneFetchDirty = false;
      setPaneView(null);
      if (prev !== null) {
        void saverRef.postRawAction({ op: "leave_pane" }).catch(() => {});
      }
    } else {
      recordVisit(key);
      if (untrack(() => paneView())?.key !== key) setPaneView(null);
    }
  };

  const waitLoop = (sinceRev: number) => {
    if (wm.st.pendingSnapshotRebase || wm.st.lastAppliedSnapshotRevision < 0) {
      bootstrapLoop();
      return;
    }
    const bootParam = wm.st.activeEngineBootId ? `&boot_id=${encodeURIComponent(wm.st.activeEngineBootId)}` : "";
    void ensureHttp()<FleetSnapshot>(`/rex/wait?since=${sinceRev}&timeout_ms=${WAIT_TIMEOUT_MS}${bootParam}`, "GET", undefined, WAIT_HTTP_TIMEOUT_MS, 256 * 1024)
      .then(snap => {
        snapSync.applySnapshot(snap);
        if (wm.st.pendingSnapshotRebase || wm.st.lastAppliedSnapshotRevision < 0) bootstrapLoop();
        else waitLoop(wm.st.lastAppliedSnapshotRevision);
      })
      .catch(err => {
        setLastError(err instanceof Error ? err.message : String(err));
        after(BACKOFF_S, bootstrapLoop);
      });
  };

  const bootstrapLoop = () => {
    void ensureHttp()<FleetSnapshot>("/rex/bootstrap", "GET", undefined, 8_000, 256 * 1024)
      .then(snap => {
        snapSync.applySnapshot(snap);
        if (wm.st.pendingSnapshotRebase || wm.st.lastAppliedSnapshotRevision < 0) after(BACKOFF_S, bootstrapLoop);
        else waitLoop(wm.st.lastAppliedSnapshotRevision);
      })
      .catch(err => {
        setConnected(false);
        setLastError(err instanceof Error ? err.message : String(err));
        after(BACKOFF_S, bootstrapLoop);
      });
  };

  const fetchActivePane = () => {
    const key = activePaneKey();
    if (!key) return;
    if (paneFetchInFlight) { paneFetchDirty = true; return; }
    paneFetchInFlight = true;
    paneFetchDirty = false;
    const seq = ++paneFetchSeq;
    const { cols, rows } = vtDims();
    void ensureHttp()<PaneViewPayload>(`/rex/pane?key=${encodeURIComponent(key)}&cols=${cols}&rows=${rows}`, "GET", undefined, 6_000, 256 * 1024)
      .then(payload => { if (activePaneKey() === key && seq === paneFetchSeq) setPaneView(payload); })
      .catch(() => {})
      .finally(() => {
        paneFetchInFlight = false;
        if (paneFetchDirty && activePaneKey()) { paneFetchDirty = false; fetchActivePane(); }
      });
  };

  const tickAgeClock = () => { setNowMs(Date.now()); after(15, tickAgeClock); };

  const start = () => {
    if (started) return;
    started = true;
    after(15, tickAgeClock);
    if (!effectInstalled) {
      effectInstalled = true;
      createEffect(() => {
        const key = activePaneKey();
        void fleet()?.revision;
        void vtDims();
        void paneRefreshTick();
        if (key) fetchActivePane();
      });
    }
    bootstrapLoop();
  };

  const dispatchAction = async (action: RexAction): Promise<ActionReply> => {
    if ((action.op === "save_draft" || action.op === "send_input" || action.op === "send_key") && wm.activeSendSessions.get(action.key)?.unconfirmedWriteSeq !== undefined) {
      return { ok: false, unconfirmed: true, error: "前一条指令发送状态未确认，请先核对终端后再操作" };
    }
    if (action.op === "save_draft" && !action.append && action.reserveBytes === undefined && action.ifDraftVer === undefined && action.ifBootId === undefined && action.clientId === undefined && action.clientSeq === undefined) {
      return saverRef.saveDraft(action.key, action.text);
    }
    if (action.op === "send_input" && !action.stage && !action.resetStage && action.stageId === undefined && action.ifDraftVer === undefined && action.ifBootId === undefined && action.clientId === undefined && action.clientSeq === undefined) {
      return senderRef.sendInput(action.key, action.data, action.clearDraft);
    }
    const reply = await saverRef.postRawAction(action);
    if (reply.ok && untrack(() => activePaneKey())) refreshPane();
    return reply;
  };

  const quitApp = () => { void ensureHttp()<unknown>("/quit", "GET", undefined, 2_000, 4096).catch(() => {}); };

  return {
    fleet, nowMs, connected, lastError, activePaneKey, setActivePaneKey, paneView, vtDims, setVtDims,
    mruKeys, recordVisit, quickSwitchOpen, setQuickSwitchOpen, isTyping, setIsTyping,
    getDraft, setLocalDraft: wm.setLocalDraft, externalDraftSeq: k => externalDraftSeqs()[k] ?? 0,
    isSending, isUnconfirmedSend, resolveUnconfirmedSend: senderRef.resolveUnconfirmedSend,
    getPendingSend, getFailedSendRestore, beginPendingSend, updatePendingSend, endPendingSend,
    getLastQueuedSaveTarget, saveDraft: saverRef.saveDraft, sendInput: senderRef.sendInput,
    start, refreshPane, dispatchAction, quitApp,
  };
}

export const rexClient: RexClient = createRexClient();
