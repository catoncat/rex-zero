// Staged `sendInput`, `(clientId, clientSeq)` `sendOutcomes` idempotency, and unconfirmed-send lock.

import { untrack, type Accessor, type Setter } from "solid-js";
import { toast } from "../notify.ts";
import type { ActionReply, FleetSnapshot, RexAction } from "../types.ts";
import { utf8 } from "../wire.ts";
import {
  MAX_STAGED_INPUT_BYTES,
  MAX_WIRE_JSON_BYTES,
  buildStagedSendPlan,
  makeActionWireCall,
} from "./chunking.ts";
import type { LocalDraftEntry } from "./reconcile.ts";
import type { RawHttpTransport } from "./ring-http.ts";
import type { SnapshotSync } from "./snapshot-sync.ts";
import type { ActiveSendSession, Watermarks } from "./watermarks.ts";

export interface SendInputDeps {
  clientId: string;
  ensureHttp: () => RawHttpTransport;
  wm: Watermarks;
  snapSync: SnapshotSync;
  postRawActionDetailed: (
    action: RexAction,
  ) => Promise<{ reply: ActionReply; transportFailed: boolean; retiredBoot: boolean }>;
  saveDraft: (key: string, fullText: string) => Promise<ActionReply>;
  localDrafts: Accessor<Record<string, LocalDraftEntry>>;
  setPendingSends: Setter<Record<string, string>>;
  setUnconfirmedSends: Setter<Record<string, boolean>>;
  clearSendSessionState: (key: string) => void;
  captureSendPreconditions: (key: string) => {
    lockedDraftVer: number | undefined;
    lockedBootId: string | undefined;
  };
  activePaneKey: Accessor<string | null>;
  refreshPane: () => void;
}

export function createSendInput(deps: SendInputDeps) {
  const {
    clientId,
    ensureHttp,
    wm,
    snapSync,
    postRawActionDetailed,
    saveDraft,
    localDrafts,
    setPendingSends,
    setUnconfirmedSends,
    clearSendSessionState,
    captureSendPreconditions,
    activePaneKey,
    refreshPane,
  } = deps;
  const {
    st,
    latestQueuedDraft,
    latestQueuedDraftSeq,
    latestQueuedSavePromise,
    lastQueuedSaveTarget,
    failedSaveKeys,
    inFlightWrites,
    pendingClearEcho,
    lastReconciledClearSeq,
    activeSendSessions,
    serverDraftVer,
    serverAppliedClientSeq,
    lastKeyAppliedRevision,
    observedSendOutcomes,
  } = wm;

  const findObservedSendOutcome = (
    key: string,
    writeSeq: number,
  ):
    | { status: "delivered"; draftCleared: boolean; draftVer: number | undefined; persistError?: string | null; fromRetiredBoot: boolean }
    | { status: "not_sent"; fromRetiredBoot: boolean }
    | null => {
    if (writeSeq <= 0) return null;
    const exact = observedSendOutcomes.get(`${clientId}:${writeSeq}`);
    if (exact) {
      const fromRetiredBoot = exact.bootId !== undefined && st.activeEngineBootId !== undefined && exact.bootId !== st.activeEngineBootId;
      if (!exact.ok) return { status: "not_sent", fromRetiredBoot };
      return {
        status: "delivered",
        draftCleared: exact.draftCleared ?? true,
        draftVer: fromRetiredBoot ? undefined : exact.draftVer,
        persistError: exact.persistError,
        fromRetiredBoot,
      };
    }
    const pending = inFlightWrites.get(key)?.find(w => w.seq === writeSeq);
    if (pending && pending.ackedAtVer !== undefined) {
      const fromRetiredBoot = pending.ackedBootId !== undefined && st.activeEngineBootId !== undefined && pending.ackedBootId !== st.activeEngineBootId;
      return { status: "delivered", draftCleared: true, draftVer: fromRetiredBoot ? undefined : pending.ackedAtVer, fromRetiredBoot };
    }
    return null;
  };

  const applySettledSendDraft = (
    key: string,
    extChanged: boolean,
    recText: string,
    staleServerNeedsClear: boolean,
    adoptCleanMatchingSrv: boolean,
    persistError?: string | null,
  ): void => {
    const notifyClearFail = (r: ActionReply, alwaysWarn = false) => {
      if (!r.ok && (alwaysWarn || persistError)) toast(r.error || "清理草稿落盘失败", "warn");
    };
    if (!extChanged) {
      if (!latestQueuedDraft.has(key)) {
        lastQueuedSaveTarget.set(key, "");
        failedSaveKeys.delete(key);
        wm.setLocalDraft(key, "", { dirty: false, baseServerText: "" });
        if (persistError || staleServerNeedsClear) {
          void saveDraft(key, "").then(r => notifyClearFail(r));
        }
      } else {
        const cur = untrack(() => localDrafts())[key];
        if (cur) wm.setLocalDraft(key, cur.text, { dirty: cur.text !== "", baseServerText: "" });
      }
      return;
    }
    if (latestQueuedDraft.has(key)) return;
    const srvNow = st.prevServerDrafts[key] ?? "";
    if (recText === "") {
      lastQueuedSaveTarget.set(key, "");
      failedSaveKeys.delete(key);
      wm.setLocalDraft(key, "", { dirty: false, baseServerText: "" });
      if (persistError || (staleServerNeedsClear && srvNow !== "")) {
        void saveDraft(key, "").then(r => notifyClearFail(r, true));
      }
    } else if (!persistError && adoptCleanMatchingSrv && srvNow === recText) {
      lastQueuedSaveTarget.set(key, recText);
      failedSaveKeys.delete(key);
      wm.setLocalDraft(key, recText, { dirty: false, baseServerText: recText });
    } else {
      wm.setLocalDraft(key, recText, { dirty: true, baseServerText: srvNow });
      void saveDraft(key, recText).then(r => notifyClearFail(r));
    }
  };

  const resolveUnconfirmedSend = (key: string, action: "discard" | "restore"): void => {
    const sess = key ? activeSendSessions.get(key) : undefined;
    const uSeq = sess?.unconfirmedWriteSeq;
    if (!sess || uSeq === undefined) return;
    wm.removePendingWrite(key, uSeq);
    const srvNow = st.prevServerDrafts[key] ?? "";
    if (action === "discard") {
      lastReconciledClearSeq.set(key, Math.max(lastReconciledClearSeq.get(key) ?? 0, uSeq));
      const keep = sess.extChanged ? sess.unsentExternal : "";
      clearSendSessionState(key);
      if (keep === srvNow) {
        lastQueuedSaveTarget.set(key, keep);
        failedSaveKeys.delete(key);
        wm.setLocalDraft(key, keep, { dirty: false, baseServerText: keep });
      } else {
        wm.setLocalDraft(key, keep, { dirty: true, baseServerText: srvNow });
        void saveDraft(key, keep);
      }
    } else {
      const restored = sess.pendingText + sess.unsentExternal;
      clearSendSessionState(key);
      wm.setLocalDraft(key, restored, { dirty: true, baseServerText: srvNow });
      void saveDraft(key, restored);
    }
  };

  const settleResolvedUnconfirmedSends = (): void => {
    for (const [uKey, sess] of Array.from(activeSendSessions.entries())) {
      const uSeq = sess.unconfirmedWriteSeq;
      if (uSeq === undefined) continue;
      const outcome = findObservedSendOutcome(uKey, uSeq);
      if (!outcome || (outcome.fromRetiredBoot && wm.needsKeyBootRebase(uKey))) continue;
      if (outcome.status !== "delivered") {
        resolveUnconfirmedSend(uKey, "restore");
        continue;
      }
      wm.removePendingWrite(uKey, uSeq);
      if (!outcome.fromRetiredBoot) {
        lastReconciledClearSeq.set(uKey, Math.max(lastReconciledClearSeq.get(uKey) ?? 0, uSeq));
        if (outcome.draftCleared && outcome.draftVer !== undefined && outcome.draftVer < (serverDraftVer.get(uKey) ?? 0)) {
          sess.unsentExternal = st.prevServerDrafts[uKey] ?? "";
          sess.extChanged = true;
        }
      }
      const srvNow = st.prevServerDrafts[uKey] ?? "";
      wm.clearAckedEchoState(uKey);
      pendingClearEcho.delete(uKey);
      clearSendSessionState(uKey);
      applySettledSendDraft(
        uKey,
        sess.extChanged,
        sess.extChanged ? sess.unsentExternal : "",
        (outcome.fromRetiredBoot || !outcome.draftCleared) && srvNow !== "",
        true,
        outcome.persistError,
      );
      if (untrack(() => activePaneKey()) === uKey) refreshPane();
    }
  };

  const probeBootstrap = async () => {
    try {
      snapSync.applySnapshot(await ensureHttp()<FleetSnapshot>("/rex/bootstrap", "GET", undefined, 4_000, 256 * 1024));
    } catch {}
  };

  const sendInput = (key: string, data: string, clearDraft?: boolean): Promise<ActionReply> => {
    if (!key) return Promise.resolve({ ok: false, error: "missing pane key" });
    if (activeSendSessions.get(key)?.unconfirmedWriteSeq !== undefined) {
      return Promise.resolve({ ok: false, unconfirmed: true, error: "前一条指令发送状态未确认，请先核对终端后再发送" });
    }
    if (utf8(data).length > MAX_STAGED_INPUT_BYTES) {
      return Promise.resolve({ ok: false, error: "staged input exceeds 64 KiB limit" });
    }
    const makeEphemeral = (): ActiveSendSession => {
      const pre = captureSendPreconditions(key);
      return {
        pendingText: data.endsWith("\r") ? data.slice(0, -1) : data,
        lockedDraftVer: pre.lockedDraftVer,
        lockedBootId: pre.lockedBootId,
        extChanged: false,
        unsentExternal: "",
        ownedByComposer: false,
      };
    };
    let preEphemeral: ActiveSendSession | null = null;
    if (clearDraft && !activeSendSessions.has(key)) {
      preEphemeral = makeEphemeral();
      activeSendSessions.set(key, preEphemeral);
    }

    const runSend = async (): Promise<ActionReply> => {
      if (activeSendSessions.get(key)?.unconfirmedWriteSeq !== undefined) {
        return { ok: false, unconfirmed: true, error: "前一条指令发送状态未确认，请先核对终端后再发送" };
      }
      let ephemeral = preEphemeral;
      if (clearDraft && !activeSendSessions.has(key)) {
        ephemeral = makeEphemeral();
        activeSendSessions.set(key, ephemeral);
      }
      const sessAtStart = clearDraft ? (activeSendSessions.get(key) ?? ephemeral) : null;
      const lockedVer = clearDraft ? sessAtStart?.lockedDraftVer : undefined;
      const lockedBoot = clearDraft ? sessAtStart?.lockedBootId : undefined;
      const writeSeq = clearDraft ? wm.addPendingWrite(key, "", true) : 0;
      let retainUnconfirmed = false;

      try {
        const bootAttr = clearDraft && lockedBoot ? { ifBootId: lockedBoot } : {};
        const idFields = clearDraft ? { ...bootAttr, clientId, clientSeq: writeSeq } : {};
        const verFields = clearDraft && lockedVer !== undefined ? { ifDraftVer: lockedVer, ...idFields } : idFields;
        const singleAction: RexAction = clearDraft === undefined ? { op: "send_input", key, data } : { op: "send_input", key, data, clearDraft, ...verFields };

        let lastReply: ActionReply = { ok: true };
        let commitTransportFailed = false;
        let commitRetiredBoot = false;
        if (utf8(JSON.stringify(makeActionWireCall(singleAction))).length <= MAX_WIRE_JSON_BYTES) {
          const res = await postRawActionDetailed(singleAction);
          lastReply = res.reply;
          commitTransportFailed = res.transportFailed;
          commitRetiredBoot = res.retiredBoot;
        } else {
          const stageId = `${clientId}-${++st.stageSeq}`;
          let plan: ReturnType<typeof buildStagedSendPlan>;
          try {
            plan = buildStagedSendPlan(key, data, clearDraft, clientId, stageId, lockedVer, bootAttr, verFields);
          } catch (err) {
            if (clearDraft && !latestQueuedDraft.has(key)) { lastQueuedSaveTarget.delete(key); failedSaveKeys.add(key); }
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          if (plan.chunks.length === 1) {
            const res = await postRawActionDetailed(singleAction);
            lastReply = res.reply;
            commitTransportFailed = res.transportFailed;
            commitRetiredBoot = res.retiredBoot;
          } else {
            for (let i = 0; i < plan.chunks.length - 1; i++) {
              const stRes = await postRawActionDetailed({
                op: "send_input", key, data: plan.chunks[i]!, stage: true, resetStage: i === 0, stageId,
                ...(i === 0 ? { ...(lockedVer !== undefined ? { ifDraftVer: lockedVer } : {}), ...bootAttr } : {}),
              });
              lastReply = stRes.reply;
              if (stRes.retiredBoot) { lastReply = { ok: false, error: "engine restarted during staged send" }; break; }
              if (!lastReply.ok) break;
            }
            if (lastReply.ok) {
              const res = await postRawActionDetailed(plan.buildCommit(plan.chunks[plan.chunks.length - 1]!, false));
              lastReply = res.reply;
              commitTransportFailed = res.transportFailed;
              commitRetiredBoot = res.retiredBoot;
            }
          }
        }

        let recoveredFromSnap = false;
        let settledAcrossBoot = false;
        if (commitRetiredBoot && lastReply.ok && clearDraft) {
          recoveredFromSnap = true;
          settledAcrossBoot = true;
          if (wm.needsKeyBootRebase(key)) await probeBootstrap();
          lastReply = { ok: true, draftCleared: lastReply.draftCleared ?? true, draftVer: undefined, persistError: lastReply.persistError };
        } else if (!lastReply.ok && clearDraft && writeSeq > 0) {
          let outcome = findObservedSendOutcome(key, writeSeq);
          if ((!outcome || (outcome.status === "delivered" && outcome.fromRetiredBoot && wm.needsKeyBootRebase(key))) && commitTransportFailed) {
            await probeBootstrap();
            outcome = findObservedSendOutcome(key, writeSeq);
          }
          if (outcome?.status === "delivered") {
            recoveredFromSnap = true;
            settledAcrossBoot = outcome.fromRetiredBoot;
            lastReply = { ok: true, draftCleared: outcome.draftCleared, draftVer: outcome.draftVer, persistError: outcome.persistError };
          } else if (commitTransportFailed && outcome?.status !== "not_sent") {
            lastReply = { ...lastReply, unconfirmed: true };
          }
        }

        if (lastReply.ok) {
          if (clearDraft) {
            const crossBoot = lockedBoot !== undefined && st.activeEngineBootId !== undefined && lockedBoot !== st.activeEngineBootId;
            if (!recoveredFromSnap && lastReply.draftCleared === false && lastReply.serverDraft !== undefined && lastReply.serverDraft !== null) {
              snapSync.ingestInlineServerDraft(
                key, lastReply.serverDraft, lastReply.revision, lastReply.draftVer, lastReply.clientId, lastReply.clientSeq,
                Boolean(lastReply.reservationRolledBack), Boolean(lastReply.provisional),
              );
              const curSess = activeSendSessions.get(key) ?? ephemeral;
              if (curSess && !curSess.extChanged && !crossBoot && !lastReply.reservationRolledBack && !lastReply.provisional && lastReply.serverDraft !== "") {
                curSess.unsentExternal = lastReply.serverDraft;
                curSess.extChanged = true;
              }
            } else if (recoveredFromSnap && lastReply.draftCleared === true && lastReply.draftVer !== undefined && lastReply.draftVer < (serverDraftVer.get(key) ?? 0)) {
              lastReconciledClearSeq.set(key, Math.max(lastReconciledClearSeq.get(key) ?? 0, writeSeq));
              const curSess = activeSendSessions.get(key) ?? ephemeral;
              if (curSess) { curSess.unsentExternal = st.prevServerDrafts[key] ?? ""; curSess.extChanged = true; }
            } else if (!recoveredFromSnap && lastReply.draftCleared === true && lastReply.draftVer !== undefined) {
              st.hasServerDraftMeta = true;
              lastReconciledClearSeq.set(key, Math.max(lastReconciledClearSeq.get(key) ?? 0, writeSeq));
              const knownVer = serverDraftVer.get(key) ?? 0;
              if (lastReply.draftVer < knownVer) {
                const curSess = activeSendSessions.get(key) ?? ephemeral;
                if (curSess) { curSess.unsentExternal = st.prevServerDrafts[key] ?? ""; curSess.extChanged = true; }
              } else {
                serverDraftVer.set(key, lastReply.draftVer);
                const cSeq = lastReply.clientId === undefined || lastReply.clientId === clientId ? (lastReply.clientSeq ?? writeSeq) : 0;
                serverAppliedClientSeq.set(key, cSeq);
                const knownRev = lastKeyAppliedRevision.get(key) ?? -1;
                if (lastReply.revision === undefined || lastReply.revision >= knownRev) {
                  if (lastReply.revision !== undefined) lastKeyAppliedRevision.set(key, Math.max(knownRev, lastReply.revision));
                  snapSync.setPrevServerDraft(key, "");
                }
              }
            }

            const sess = activeSendSessions.get(key) ?? ephemeral;
            wm.clearAckedEchoState(key);
            const clearPast = recoveredFromSnap || (lastReply.draftVer !== undefined && (serverDraftVer.get(key) ?? 0) > lastReply.draftVer);
            if (!clearPast && lastReply.draftCleared !== false && (st.prevServerDrafts[key] ?? "") !== "") {
              pendingClearEcho.set(key, { atRevision: lastReply.revision, atDraftVer: lastReply.draftVer });
            } else {
              pendingClearEcho.delete(key);
            }
            const clearSuperseded = recoveredFromSnap || (lastReply.draftCleared === true && lastReply.draftVer !== undefined && (serverDraftVer.get(key) ?? 0) > lastReply.draftVer);
            applySettledSendDraft(
              key,
              sess?.extChanged ?? false,
              sess?.unsentExternal ?? "",
              (settledAcrossBoot || crossBoot || lastReply.draftCleared === false) && (st.prevServerDrafts[key] ?? "") !== "",
              lastReply.draftCleared === false || clearSuperseded,
              lastReply.persistError,
            );
          }
          if (untrack(() => activePaneKey())) refreshPane();
        } else if (clearDraft && lastReply.unconfirmed && writeSeq > 0) {
          const curSess = activeSendSessions.get(key) ?? ephemeral;
          if (curSess) {
            curSess.unconfirmedWriteSeq = writeSeq;
            activeSendSessions.set(key, curSess);
            setPendingSends(prev => ({ ...prev, [key]: curSess.pendingText }));
            setUnconfirmedSends(prev => ({ ...prev, [key]: true }));
            retainUnconfirmed = true;
          }
        } else if (clearDraft && !latestQueuedDraft.has(key)) {
          lastQueuedSaveTarget.delete(key);
          failedSaveKeys.add(key);
        }
        return lastReply;
      } finally {
        if (clearDraft && !retainUnconfirmed) wm.removePendingWrite(key, writeSeq);
        if (!retainUnconfirmed && ephemeral && activeSendSessions.get(key) === ephemeral) {
          activeSendSessions.delete(key);
        }
      }
    };

    if (clearDraft) {
      latestQueuedDraft.delete(key);
      latestQueuedDraftSeq.set(key, ++st.draftSaveSeq);
      latestQueuedSavePromise.delete(key);
      return wm.enqueueDraftOp<ActionReply>(key, runSend);
    }
    return runSend();
  };

  return { sendInput, resolveUnconfirmedSend, settleResolvedUnconfirmedSends };
}
