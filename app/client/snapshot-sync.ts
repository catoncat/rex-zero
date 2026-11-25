// Inline and snapshot draft reconciliation against local edits, clears, and restarts.

import { batch, type Accessor, type Setter } from "solid-js";
import { toast } from "../notify.ts";
import type { FleetSnapshot } from "../types.ts";
import {
  reconcileRestartDraft,
  reconcileServerDraftUpdate,
  type LocalDraftEntry,
} from "./reconcile.ts";
import type { Watermarks } from "./watermarks.ts";

export interface SnapshotSyncDeps {
  wm: Watermarks;
  setFleet: Setter<FleetSnapshot | null>;
  activePaneKey: Accessor<string | null>;
  setConnected: Setter<boolean>;
  setLastError: Setter<string>;
  setLocalDrafts: Setter<Record<string, LocalDraftEntry>>;
  setExternalDraftSeqs: Setter<Record<string, number>>;
  triggerSaveDraft: (key: string, text: string) => void;
  onSettledUnconfirmedSends: () => void;
}

export function createSnapshotSync(deps: SnapshotSyncDeps) {
  const { wm, setFleet, activePaneKey, setConnected, setLastError, setLocalDrafts, setExternalDraftSeqs } = deps;
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
    inFlightSaveCounts,
    activeSaveOps,
    serverChangeSeq,
    serverDraftVer,
    serverAppliedClientSeq,
    lastKeyAppliedRevision,
    preRestartEchoes,
    pendingBootRebaseKeys,
    reconciledOnActiveBoot,
  } = wm;

  const setPrevServerDraft = (key: string, val: string): void => {
    if (val === "") {
      if (!(key in st.prevServerDrafts)) return;
      const copy = { ...st.prevServerDrafts };
      delete copy[key];
      st.prevServerDrafts = copy;
    } else {
      st.prevServerDrafts = { ...st.prevServerDrafts, [key]: val };
    }
  };

  const reconcileKeyOnRestart = (
    k: string,
    oldSrv: string,
    newSrv: string,
    entry: LocalDraftEntry | undefined,
    invalidateQueuedOnClean: boolean,
  ): { nextEntry: LocalDraftEntry; bumped: boolean; needsSave: boolean } => {
    pendingBootRebaseKeys.delete(k);
    reconciledOnActiveBoot.add(k);
    const echoSet = preRestartEchoes.get(k);
    preRestartEchoes.delete(k);
    const sendSess = activeSendSessions.get(k);
    if (sendSess) {
      if (newSrv === "") {
        if (oldSrv !== "" || sendSess.unsentExternal !== "") {
          sendSess.unsentExternal = "";
          sendSess.extChanged = true;
        }
      } else if (oldSrv !== "" && newSrv.startsWith(oldSrv)) {
        let best = oldSrv;
        for (const c of echoSet ?? []) {
          if (c && newSrv.startsWith(c) && c.length > best.length) best = c;
        }
        const suffix = newSrv.slice(best.length);
        if (suffix.length > 0) {
          sendSess.unsentExternal += suffix;
          sendSess.extChanged = true;
        }
      } else {
        let best = "";
        for (const c of [sendSess.pendingText, ...(echoSet ?? [])]) {
          if (c && newSrv.startsWith(c) && c.length > best.length) best = c;
        }
        const suffix = newSrv.slice(best.length);
        if (suffix !== sendSess.unsentExternal) {
          sendSess.unsentExternal = suffix;
          sendSess.extChanged = true;
        }
      }
    }
    const r = reconcileRestartDraft(oldSrv, newSrv, entry, echoSet, activeSaveOps.get(k)?.fullText);
    if (!r.nextEntry.dirty) {
      if (invalidateQueuedOnClean) {
        latestQueuedDraft.delete(k);
        latestQueuedDraftSeq.set(k, ++st.draftSaveSeq);
        latestQueuedSavePromise.delete(k);
        failedSaveKeys.delete(k);
      }
      lastQueuedSaveTarget.set(k, newSrv);
    }
    return r;
  };

  const applySingleKeyServerTransition = (
    k: string,
    oldSrv: string,
    newSrv: string,
    prevEntry: LocalDraftEntry | undefined,
    maxCommittedClientSeq?: number,
    observedDraftVer?: number,
    interveningClearSeq = 0,
    forceExternalReplace = false,
    reservationRolledBack = false,
  ): { nextEntry: LocalDraftEntry | undefined; bumped: boolean; needsSave: boolean } => {
    const clearInfo = pendingClearEcho.get(k);
    if (interveningClearSeq > 0) {
      lastReconciledClearSeq.set(k, Math.max(lastReconciledClearSeq.get(k) ?? 0, interveningClearSeq));
    }
    if (!reservationRolledBack) wm.latchCommittedFirstChunk(k, maxCommittedClientSeq, observedDraftVer);
    else wm.clearAckedEchoState(k);

    const interveningClear = interveningClearSeq > 0 || forceExternalReplace || (newSrv !== "" && clearInfo !== undefined);
    const effectiveOldSrv = interveningClear ? "" : oldSrv;
    const pendingSet = reservationRolledBack ? undefined : wm.getEligiblePendingEchoSet(k, maxCommittedClientSeq, newSrv === "" ? 0 : interveningClearSeq);
    const ackedSet = interveningClear || reservationRolledBack ? undefined : wm.getEligibleAckedEchoSet(k, observedDraftVer);
    const lastAcked = interveningClear || reservationRolledBack ? undefined : wm.getEligibleLastAckedSave(k, observedDraftVer);
    const matchedPendingClear =
      newSrv === "" &&
      clearInfo !== undefined &&
      (clearInfo.atDraftVer === undefined || observedDraftVer === undefined || observedDraftVer <= clearInfo.atDraftVer);
    let effectiveAcked: ReadonlySet<string> | undefined = ackedSet;
    if (matchedPendingClear && (!ackedSet || !ackedSet.has(""))) {
      const merged = new Set<string>(ackedSet);
      merged.add("");
      effectiveAcked = merged;
    }
    const entryForReconcile = interveningClear && prevEntry ? { ...prevEntry, baseServerText: "" } : prevEntry;
    let res = reconcileServerDraftUpdate({
      oldSrv: effectiveOldSrv,
      newSrv,
      entry: entryForReconcile,
      lastAckedSave: lastAcked,
      pendingEchoes: pendingSet,
      ackedEchoes: effectiveAcked,
    });

    const activeOp = activeSaveOps.get(k);
    const chunk0Landed =
      activeOp !== undefined &&
      (activeOp.firstChunkAcked || (maxCommittedClientSeq !== undefined && maxCommittedClientSeq >= activeOp.firstChunkSeq));
    if (!res.isEcho && newSrv === "" && (oldSrv !== "" || chunk0Landed) && prevEntry?.dirty) {
      const clearedPrefix = chunk0Landed ? activeOp!.fullText : prevEntry.baseServerText;
      if (activeOp && !chunk0Landed && !activeOp.pendingExternalClear) {
        activeOp.pendingExternalClear = { ver: observedDraftVer, bootId: st.activeEngineBootId, strippedPrefix: clearedPrefix };
      }
      if (latestQueuedDraft.has(k)) {
        latestQueuedDraft.delete(k);
        if (activeOp) latestQueuedDraftSeq.set(k, activeOp.opSeq);
        else {
          latestQueuedDraftSeq.set(k, ++st.draftSaveSeq);
          latestQueuedSavePromise.delete(k);
        }
      }
      const surviving = clearedPrefix.length > 0 && prevEntry.text.startsWith(clearedPrefix) ? prevEntry.text.slice(clearedPrefix.length) : prevEntry.text;
      res = {
        isEcho: false,
        nextEntry: { text: surviving, baseServerText: "", dirty: surviving !== "" },
        bumped: true,
        needsSave: !(activeOp !== undefined && !chunk0Landed) && surviving !== "",
      };
    }

    if (res.isEcho) {
      if (matchedPendingClear) {
        pendingClearEcho.delete(k);
        if (ackedSet?.has("")) wm.consumeMatchedEcho(k, "");
      } else {
        wm.consumeMatchedEcho(k, newSrv);
        if (clearInfo !== undefined && newSrv !== "") pendingClearEcho.delete(k);
      }
    } else {
      serverChangeSeq.set(k, (serverChangeSeq.get(k) ?? 0) + 1);
      if (res.nextEntry && !res.nextEntry.dirty) {
        lastQueuedSaveTarget.set(k, newSrv);
        failedSaveKeys.delete(k);
      }
      const sendSess = activeSendSessions.get(k);
      if (sendSess) {
        if (forceExternalReplace) {
          sendSess.unsentExternal = newSrv;
        } else if (interveningClear) {
          let clearBase = "";
          if (pendingSet) for (const c of pendingSet) if (c && newSrv.startsWith(c) && c.length > clearBase.length) clearBase = c;
          sendSess.unsentExternal = newSrv.slice(clearBase.length);
        } else {
          let extBase: string | null = newSrv.startsWith(effectiveOldSrv) ? effectiveOldSrv : null;
          const check = (c?: string) => {
            if (c && newSrv.startsWith(c) && (extBase === null || c.length > extBase.length)) extBase = c;
          };
          check(lastAcked);
          check(entryForReconcile?.baseServerText);
          if (pendingSet) for (const c of pendingSet) check(c);
          if (ackedSet) for (const c of ackedSet) check(c);
          if (extBase !== null && newSrv !== "") sendSess.unsentExternal += newSrv.slice(extBase.length);
          else sendSess.unsentExternal = newSrv;
        }
        sendSess.extChanged = true;
      }
    }
    return res;
  };

  const ingestInlineServerDraft = (
    key: string,
    srvDraft: string,
    replyRevision?: number,
    replyDraftVer?: number,
    replyClientId?: string | null,
    replyClientSeq?: number,
    reservationRolledBack = false,
    provisional = false,
  ): void => {
    const maxCommittedSeq = wm.resolveLocalCommittedSeq(replyDraftVer !== undefined, replyClientId, replyClientSeq);
    const prevAppliedSeq = serverAppliedClientSeq.get(key) ?? 0;
    const isOwnProv = (maxCommittedSeq ?? 0) > 0 || (!st.hasServerDraftMeta && !replyClientId && activeSaveOps.has(key));
    if (provisional && !reservationRolledBack && !isOwnProv) return;

    const needsRebase = wm.needsKeyBootRebase(key);
    if (!reservationRolledBack) wm.latchCommittedFirstChunk(key, maxCommittedSeq, replyDraftVer);
    let isForeignAdvance = false;
    if (replyDraftVer !== undefined) {
      st.hasServerDraftMeta = true;
      if (serverDraftVer.has(key) && replyDraftVer <= serverDraftVer.get(key)! && !needsRebase) return;
      isForeignAdvance = !needsRebase && (maxCommittedSeq ?? 0) <= prevAppliedSeq;
      serverDraftVer.set(key, replyDraftVer);
      serverAppliedClientSeq.set(key, maxCommittedSeq ?? 0);
    } else if (replyRevision !== undefined && replyRevision < (lastKeyAppliedRevision.get(key) ?? -1)) {
      return;
    }
    if (replyRevision !== undefined) lastKeyAppliedRevision.set(key, Math.max(lastKeyAppliedRevision.get(key) ?? -1, replyRevision));

    const oldSrv = st.prevServerDrafts[key] ?? "";
    if (needsRebase) {
      setPrevServerDraft(key, srvDraft);
      serverChangeSeq.set(key, (serverChangeSeq.get(key) ?? 0) + 1);
      let bumped = false;
      batch(() => {
        setLocalDrafts(prev => {
          const r = reconcileKeyOnRestart(key, oldSrv, srvDraft, prev[key], false);
          bumped = r.bumped;
          return { ...prev, [key]: r.nextEntry };
        });
        if (bumped) setExternalDraftSeqs(prev => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
      });
      return;
    }

    const clearSeq = wm.getMaxCommittedClearSeq(key, maxCommittedSeq);
    const nonProvForeign = !reservationRolledBack && !provisional && isForeignAdvance && clearSeq === 0;
    const forceExternalReplace = nonProvForeign && srvDraft === oldSrv && srvDraft !== "";
    const activeOp = activeSaveOps.get(key);
    const foreignEmptyDuringSave = nonProvForeign && srvDraft === "" && oldSrv === "" && activeOp !== undefined;
    if (srvDraft === oldSrv && clearSeq === 0 && !forceExternalReplace) {
      if (foreignEmptyDuringSave && !activeOp.firstChunkAcked && !activeOp.pendingExternalClear) {
        activeOp.pendingExternalClear = { ver: replyDraftVer, bootId: st.activeEngineBootId, strippedPrefix: "" };
      }
      if (!foreignEmptyDuringSave || !activeOp.firstChunkAcked) return;
    }
    setPrevServerDraft(key, srvDraft);
    let bumped = false;
    batch(() => {
      setLocalDrafts(prev => {
        const res = applySingleKeyServerTransition(key, oldSrv, srvDraft, prev[key], maxCommittedSeq, replyDraftVer, clearSeq, forceExternalReplace, reservationRolledBack);
        bumped = res.bumped;
        return res.nextEntry ? { ...prev, [key]: res.nextEntry } : prev;
      });
      if (bumped) setExternalDraftSeqs(prev => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
    });
  };

  const applySnapshot = (next: FleetSnapshot): void => {
    if (wm.inspectIncomingBootId(next.bootId) === "retired" || next.revision < st.lastAppliedSnapshotRevision) {
      wm.harvestSendEvidenceFromSnapshot(next);
      deps.onSettledUnconfirmedSends();
      return;
    }
    const restartedSnapshot = st.pendingSnapshotRebase;
    st.pendingSnapshotRebase = false;
    st.lastAppliedSnapshotRevision = next.revision;
    const prevSeq = st.lastChimeSeq;
    st.lastChimeSeq = next.attention.chimeSeq;
    const snapHasMeta = next.draftMeta !== undefined;
    if (snapHasMeta) st.hasServerDraftMeta = true;
    wm.harvestSendEvidenceFromSnapshot(next);

    const prevServer = st.prevServerDrafts;
    const nextServer = next.drafts;
    const nextPrevServer: Record<string, string> = { ...prevServer };
    const mergedToSave: { key: string; text: string }[] = [];

    const foreignProvisionalKeys = new Set<string>();
    if (snapHasMeta) {
      for (const [k, meta] of Object.entries(next.draftMeta!)) {
        if (meta.provisional && !meta.reservationRolledBack) {
          const locSeq = wm.resolveLocalCommittedSeq(true, meta.clientId, meta.clientSeq) ?? 0;
          if (locSeq === 0 && !(!st.hasServerDraftMeta && !meta.clientId && activeSaveOps.has(k))) foreignProvisionalKeys.add(k);
        }
      }
    }
    let fleetForUi = next;
    if (foreignProvisionalKeys.size > 0) {
      const uiDrafts = { ...next.drafts };
      for (const fk of foreignProvisionalKeys) {
        const held = prevServer[fk] ?? "";
        if (held === "") delete uiDrafts[fk];
        else uiDrafts[fk] = held;
      }
      fleetForUi = {
        ...next,
        drafts: uiDrafts,
        panes: next.panes.map(p => (foreignProvisionalKeys.has(p.key) ? { ...p, hasDraft: Boolean(uiDrafts[p.key]) } : p)),
      };
    }

    batch(() => {
      setFleet(fleetForUi);
      setConnected(true);
      setLastError("");
      const bumpedKeys: string[] = [];
      setLocalDrafts(prev => {
        let updated: Record<string, LocalDraftEntry> | null = null;
        const allKeys = new Set<string>([
          ...Object.keys(prevServer),
          ...Object.keys(nextServer),
          ...Object.keys(prev),
          ...Object.keys(next.draftMeta ?? {}),
          ...(restartedSnapshot ? Array.from(pendingBootRebaseKeys) : []),
        ]);
        for (const k of allKeys) {
          if (foreignProvisionalKeys.has(k)) {
            if (restartedSnapshot) pendingBootRebaseKeys.add(k);
            continue;
          }
          const keyRebase = (restartedSnapshot || pendingBootRebaseKeys.has(k)) && !reconciledOnActiveBoot.has(k);
          const oldSrv = prevServer[k] ?? "";
          const newSrv = nextServer[k] ?? "";
          const snapMeta = snapHasMeta ? (next.draftMeta![k] ?? { ver: 0, clientSeq: 0 }) : undefined;
          const locSeq = wm.resolveLocalCommittedSeq(snapHasMeta, snapMeta?.clientId, snapMeta?.clientSeq);
          const prevRawVer = serverDraftVer.has(k) ? serverDraftVer.get(k) : st.hasServerDraftMeta ? 0 : undefined;
          let isForeignAdvance = false;

          if (snapMeta !== undefined) {
            if (!keyRebase && serverDraftVer.has(k) && snapMeta.ver < serverDraftVer.get(k)!) {
              if (!snapMeta.reservationRolledBack) wm.latchCommittedFirstChunk(k, locSeq, snapMeta.ver);
              continue;
            }
            isForeignAdvance = !keyRebase && prevRawVer !== undefined && snapMeta.ver > prevRawVer && (locSeq ?? 0) <= (serverAppliedClientSeq.get(k) ?? 0);
            serverDraftVer.set(k, snapMeta.ver);
            serverAppliedClientSeq.set(k, locSeq ?? 0);
          } else if (!keyRebase && next.revision < (lastKeyAppliedRevision.get(k) ?? -1)) {
            continue;
          }
          lastKeyAppliedRevision.set(k, Math.max(lastKeyAppliedRevision.get(k) ?? -1, next.revision));
          if (newSrv === "") delete nextPrevServer[k];
          else nextPrevServer[k] = newSrv;

          if (keyRebase) {
            const r = reconcileKeyOnRestart(k, oldSrv, newSrv, prev[k], true);
            if (!updated) updated = { ...prev };
            updated[k] = r.nextEntry;
            if (r.bumped) bumpedKeys.push(k);
            if (r.needsSave && (inFlightSaveCounts.get(k) ?? 0) === 0) mergedToSave.push({ key: k, text: r.nextEntry.text });
            continue;
          }

          const clearSeq = wm.getMaxCommittedClearSeq(k, locSeq);
          const snapRolledBack = Boolean(snapMeta?.reservationRolledBack);
          const nonProvForeign = !snapRolledBack && !snapMeta?.provisional && isForeignAdvance && clearSeq === 0;
          const forceExternalReplace = nonProvForeign && newSrv === oldSrv && newSrv !== "";
          const activeOp = activeSaveOps.get(k);
          const foreignEmptyDuringSave = nonProvForeign && newSrv === "" && oldSrv === "" && activeOp !== undefined;
          if (newSrv === oldSrv && clearSeq === 0 && !forceExternalReplace) {
            if (foreignEmptyDuringSave && !activeOp.firstChunkAcked && !activeOp.pendingExternalClear) {
              activeOp.pendingExternalClear = { ver: snapMeta?.ver, bootId: st.activeEngineBootId, strippedPrefix: "" };
            }
            if (!foreignEmptyDuringSave || !activeOp.firstChunkAcked) {
              if (!snapRolledBack) wm.latchCommittedFirstChunk(k, locSeq, snapMeta?.ver);
              const clearInfo = pendingClearEcho.get(k);
              const idleNoWrites = (inFlightSaveCounts.get(k) ?? 0) === 0 && (inFlightWrites.get(k)?.length ?? 0) === 0;
              if (
                clearInfo &&
                ((clearInfo.atDraftVer !== undefined && snapMeta !== undefined && snapMeta.ver >= clearInfo.atDraftVer) ||
                  (clearInfo.atRevision !== undefined && next.revision >= clearInfo.atRevision) ||
                  (clearInfo.atRevision === undefined && idleNoWrites))
              ) {
                pendingClearEcho.delete(k);
              }
              if (idleNoWrites && wm.getEligibleAckedEchoSet(k, snapMeta?.ver)?.has(newSrv)) wm.consumeMatchedEcho(k, newSrv);
              continue;
            }
          }

          const res = applySingleKeyServerTransition(k, oldSrv, newSrv, prev[k], locSeq, snapMeta?.ver, clearSeq, forceExternalReplace, snapRolledBack);
          if (res.nextEntry) {
            if (!updated) updated = { ...prev };
            updated[k] = res.nextEntry;
          }
          if (res.bumped) bumpedKeys.push(k);
          if (res.needsSave && res.nextEntry) {
            failedSaveKeys.delete(k);
            mergedToSave.push({ key: k, text: res.nextEntry.text });
          }
        }
        return updated ?? prev;
      });
      st.prevServerDrafts = nextPrevServer;
      if (bumpedKeys.length > 0) {
        setExternalDraftSeqs(prev => {
          const nextSeqs = { ...prev };
          for (const k of bumpedKeys) nextSeqs[k] = (nextSeqs[k] ?? 0) + 1;
          return nextSeqs;
        });
      }
    });

    if (pendingBootRebaseKeys.size === 0 && reconciledOnActiveBoot.size > 0) reconciledOnActiveBoot.clear();
    for (const item of mergedToSave) deps.triggerSaveDraft(item.key, item.text);
    deps.onSettledUnconfirmedSends();

    if (prevSeq >= 0 && st.lastChimeSeq > prevSeq && !next.attention.muted) {
      const target = next.attention.nextTargetKey;
      if (!target || target !== activePaneKey()) {
        if (next.attention.chimeKind === "approval") toast("有待批会话等待确认 (^N切)", "accent");
        else if (next.attention.chimeKind === "error") toast("后台会话报错 (^N查看)", "warn");
        else if (next.attention.chimeKind === "done") toast("后台任务已完成 (^N查看)", "ok");
      }
    }
  };

  return { setPrevServerDraft, ingestInlineServerDraft, applySnapshot };
}

export type SnapshotSync = ReturnType<typeof createSnapshotSync>;
