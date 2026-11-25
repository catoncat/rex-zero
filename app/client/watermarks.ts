// Per-client CAS watermarks, bootId lifecycle, in-flight/acknowledged echoes, and send evidence.

import { untrack, type Accessor, type Setter } from "solid-js";
import type { ActionReply, FleetSnapshot } from "../types.ts";
import type { LocalDraftEntry } from "./reconcile.ts";

export interface PendingClientWrite {
  seq: number;
  value: string;
  isClear: boolean;
  ackedAtVer?: number;
  ackedBootId?: string;
}

export interface ActiveSendSession {
  pendingText: string;
  lockedDraftVer: number | undefined;
  lockedBootId: string | undefined;
  extChanged: boolean;
  unsentExternal: string;
  ownedByComposer: boolean;
  unconfirmedWriteSeq?: number;
}

export interface ActiveSaveOp {
  opSeq: number;
  fullText: string;
  firstChunkSeq: number;
  firstChunkAcked: boolean;
  pendingExternalClear?: {
    ver: number | undefined;
    bootId: string | undefined;
    strippedPrefix: string;
  };
}

export interface WatermarksDeps {
  clientId: string;
  fleet: Accessor<FleetSnapshot | null>;
  localDrafts: Accessor<Record<string, LocalDraftEntry>>;
  setLocalDrafts: Setter<Record<string, LocalDraftEntry>>;
}

export function createWatermarks(deps: WatermarksDeps) {
  const { clientId, fleet, localDrafts, setLocalDrafts } = deps;

  const draftOpChain = new Map<string, Promise<unknown>>();
  const latestQueuedDraft = new Map<string, string>();
  const latestQueuedDraftSeq = new Map<string, number>();
  const latestQueuedSavePromise = new Map<string, Promise<ActionReply>>();
  const lastQueuedSaveTarget = new Map<string, string>();
  const reservedSaveEntries = new Map<string, number>();
  const failedSaveKeys = new Set<string>();
  const lastAckedClientSave = new Map<string, string>();
  const lastAckedClientSaveVer = new Map<string, number | undefined>();
  const inFlightWrites = new Map<string, PendingClientWrite[]>();
  const ackedWriteEchoes = new Map<string, Map<string, number | undefined>>();
  const pendingClearEcho = new Map<string, { atRevision?: number; atDraftVer?: number }>();
  const lastReconciledClearSeq = new Map<string, number>();
  const activeSendSessions = new Map<string, ActiveSendSession>();
  const inFlightSaveCounts = new Map<string, number>();
  const activeSaveOps = new Map<string, ActiveSaveOp>();
  const serverChangeSeq = new Map<string, number>();
  const serverDraftVer = new Map<string, number>();
  const serverAppliedClientSeq = new Map<string, number>();
  const lastKeyAppliedRevision = new Map<string, number>();
  const observedSendOutcomes = new Map<
    string,
    {
      ok: boolean;
      draftCleared?: boolean | null;
      draftVer?: number;
      persistError?: string | null;
      bootId?: string;
    }
  >();
  const retiredEngineBootIds = new Set<string>();
  const preRestartEchoes = new Map<string, Set<string>>();
  const pendingBootRebaseKeys = new Set<string>();
  const reconciledOnActiveBoot = new Set<string>();

  const st = {
    activeEngineBootId: undefined as string | undefined,
    lastRetiredBootId: undefined as string | undefined,
    pendingSnapshotRebase: false,
    engineEpoch: 0,
    hasServerDraftMeta: false,
    lastAppliedSnapshotRevision: -1,
    lastChimeSeq: -1,
    prevServerDrafts: {} as Record<string, string>,
    draftSaveSeq: 0,
    clientWriteSeq: 0,
    stageSeq: 0,
  };

  const inspectIncomingBootId = (incomingBootId?: string): "same" | "restarted" | "retired" => {
    if (!incomingBootId) return "same";
    if (retiredEngineBootIds.has(incomingBootId)) return "retired";
    if (st.activeEngineBootId === undefined) {
      st.activeEngineBootId = incomingBootId;
      return "same";
    }
    if (st.activeEngineBootId === incomingBootId) return "same";

    if (retiredEngineBootIds.size >= 64) {
      const oldest = retiredEngineBootIds.values().next().value;
      if (oldest !== undefined) retiredEngineBootIds.delete(oldest);
    }
    st.lastRetiredBootId = st.activeEngineBootId;
    retiredEngineBootIds.add(st.activeEngineBootId);

    preRestartEchoes.clear();
    const recordPre = (k: string, val: string | undefined) => {
      if (val === undefined) return;
      let set = preRestartEchoes.get(k);
      if (!set) {
        set = new Set<string>();
        preRestartEchoes.set(k, set);
      }
      set.add(val);
    };
    for (const [k, v] of lastAckedClientSave) recordPre(k, v);
    for (const [k, map] of ackedWriteEchoes) {
      for (const v of map.keys()) recordPre(k, v);
    }

    st.activeEngineBootId = incomingBootId;
    st.pendingSnapshotRebase = true;
    reconciledOnActiveBoot.clear();
    pendingBootRebaseKeys.clear();
    for (const k of [
      ...Object.keys(st.prevServerDrafts),
      ...Object.keys(untrack(() => localDrafts())),
      ...activeSendSessions.keys(),
      ...activeSaveOps.keys(),
      ...preRestartEchoes.keys(),
    ]) {
      pendingBootRebaseKeys.add(k);
    }
    st.hasServerDraftMeta = false;
    st.engineEpoch++;
    st.lastAppliedSnapshotRevision = -1;
    st.lastChimeSeq = -1;
    lastKeyAppliedRevision.clear();
    serverDraftVer.clear();
    serverAppliedClientSeq.clear();
    lastReconciledClearSeq.clear();
    pendingClearEcho.clear();
    ackedWriteEchoes.clear();
    lastAckedClientSave.clear();
    lastAckedClientSaveVer.clear();
    for (const op of activeSaveOps.values()) op.firstChunkAcked = false;
    for (const list of inFlightWrites.values()) {
      for (const w of list) {
        if (!w.isClear) {
          w.ackedAtVer = undefined;
          w.ackedBootId = undefined;
        }
      }
    }
    for (const k of new Set([
      ...serverChangeSeq.keys(),
      ...Object.keys(st.prevServerDrafts),
      ...Object.keys(untrack(() => localDrafts())),
    ])) {
      serverChangeSeq.set(k, (serverChangeSeq.get(k) ?? 0) + 1);
    }
    return "restarted";
  };

  const getKnownServerDraftVer = (key: string): number | undefined =>
    serverDraftVer.has(key) ? serverDraftVer.get(key) : st.hasServerDraftMeta ? 0 : undefined;

  const needsKeyBootRebase = (key: string): boolean =>
    (st.pendingSnapshotRebase || pendingBootRebaseKeys.has(key)) &&
    !reconciledOnActiveBoot.has(key);

  const resolveLocalCommittedSeq = (
    hasMeta: boolean,
    metaClientId: string | null | undefined,
    metaClientSeq: number | undefined,
  ): number | undefined =>
    !hasMeta ? undefined : metaClientId === clientId ? (metaClientSeq ?? 0) : 0;

  const addPendingWrite = (key: string, value: string, isClear = false): number => {
    const seq = ++st.clientWriteSeq;
    const list = inFlightWrites.get(key) ?? [];
    list.push({ seq, value, isClear });
    inFlightWrites.set(key, list);
    return seq;
  };

  const removePendingWrite = (key: string, seq: number): void => {
    observedSendOutcomes.delete(`${clientId}:${seq}`);
    const list = inFlightWrites.get(key);
    if (!list) return;
    const idx = list.findIndex(w => w.seq === seq);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) inFlightWrites.delete(key);
  };

  const latchCommittedFirstChunk = (
    key: string,
    maxCommittedClientSeq?: number,
    observedVer?: number,
    observedBootId = st.activeEngineBootId,
  ): void => {
    if (maxCommittedClientSeq === undefined || maxCommittedClientSeq <= 0) return;
    const activeOp = activeSaveOps.get(key);
    if (activeOp && maxCommittedClientSeq >= activeOp.firstChunkSeq) {
      activeOp.firstChunkAcked = true;
    }
    for (const w of inFlightWrites.get(key) ?? []) {
      const matched = w.isClear ? w.seq === maxCommittedClientSeq : w.seq <= maxCommittedClientSeq;
      if (matched && w.ackedAtVer === undefined) {
        w.ackedAtVer = observedVer ?? serverDraftVer.get(key) ?? 0;
        w.ackedBootId = observedBootId;
      }
    }
  };

  const getMaxCommittedClearSeq = (key: string, maxCommittedClientSeq?: number): number => {
    if (maxCommittedClientSeq === undefined || maxCommittedClientSeq <= 0) return 0;
    const already = lastReconciledClearSeq.get(key) ?? 0;
    let best = 0;
    for (const w of inFlightWrites.get(key) ?? []) {
      if (w.isClear && w.seq > already && w.seq <= maxCommittedClientSeq && w.seq > best) {
        best = w.seq;
      }
    }
    return best;
  };

  const getEligiblePendingEchoSet = (
    key: string,
    maxCommittedClientSeq?: number,
    minSeqExclusive = 0,
  ): ReadonlySet<string> | undefined => {
    const list = inFlightWrites.get(key);
    if (!list || list.length === 0) return undefined;
    const set = new Set<string>();
    for (const w of list) {
      if (
        w.seq > minSeqExclusive &&
        (maxCommittedClientSeq === undefined || w.seq <= maxCommittedClientSeq)
      ) {
        set.add(w.value);
      }
    }
    return set.size > 0 ? set : undefined;
  };

  const getEligibleAckedEchoSet = (
    key: string,
    observedDraftVer?: number,
  ): ReadonlySet<string> | undefined => {
    const map = ackedWriteEchoes.get(key);
    if (!map || map.size === 0) return undefined;
    const out = new Set<string>();
    for (const [val, ver] of map) {
      if (observedDraftVer === undefined || ver === undefined || ver === observedDraftVer) {
        out.add(val);
      }
    }
    return out.size > 0 ? out : undefined;
  };

  const getEligibleLastAckedSave = (key: string, observedDraftVer?: number): string | undefined => {
    if (!lastAckedClientSave.has(key)) return undefined;
    const ver = lastAckedClientSaveVer.get(key);
    if (observedDraftVer !== undefined && ver !== undefined && ver !== observedDraftVer) {
      return undefined;
    }
    return lastAckedClientSave.get(key);
  };

  const clearAckedEchoState = (key: string): void => {
    ackedWriteEchoes.delete(key);
    lastAckedClientSave.delete(key);
    lastAckedClientSaveVer.delete(key);
  };

  const recordAckedEcho = (
    key: string,
    value: string,
    replacePrevious: boolean,
    commitVer?: number,
  ): void => {
    lastAckedClientSave.set(key, value);
    lastAckedClientSaveVer.set(key, commitVer);
    let map = ackedWriteEchoes.get(key);
    if (!map) {
      map = new Map<string, number | undefined>();
      ackedWriteEchoes.set(key, map);
    } else if (replacePrevious) {
      map.clear();
    }
    if (map.has(value)) map.delete(value);
    map.set(value, commitVer);
  };

  const consumeMatchedEcho = (key: string, matchedValue: string): void => {
    if (lastAckedClientSave.get(key) === matchedValue) {
      lastAckedClientSave.delete(key);
      lastAckedClientSaveVer.delete(key);
    }
    const map = ackedWriteEchoes.get(key);
    if (!map || !map.has(matchedValue)) return;
    for (const entry of Array.from(map.keys())) {
      map.delete(entry);
      if (entry === matchedValue) break;
    }
    if (map.size === 0) ackedWriteEchoes.delete(key);
  };

  const harvestSendEvidenceFromSnapshot = (snap: FleetSnapshot): void => {
    const outKeys = new Set<string>();
    for (const list of inFlightWrites.values()) {
      for (const w of list) if (w.isClear) outKeys.add(`${clientId}:${w.seq}`);
    }
    for (const sess of activeSendSessions.values()) {
      if (sess.unconfirmedWriteSeq !== undefined) {
        outKeys.add(`${clientId}:${sess.unconfirmedWriteSeq}`);
      }
    }
    for (const existing of Array.from(observedSendOutcomes.keys())) {
      if (!outKeys.has(existing)) observedSendOutcomes.delete(existing);
    }
    const snapBoot = snap.bootId ?? st.activeEngineBootId;
    if (snap.sendOutcomes && outKeys.size > 0) {
      for (const [id, out] of Object.entries(snap.sendOutcomes)) {
        if (outKeys.has(id)) observedSendOutcomes.set(id, { ...out, bootId: snapBoot });
      }
    }
    if (snap.draftMeta) {
      for (const [k, meta] of Object.entries(snap.draftMeta)) {
        if (meta.clientId === clientId && (meta.clientSeq ?? 0) > 0) {
          for (const w of inFlightWrites.get(k) ?? []) {
            if (w.isClear && w.seq === meta.clientSeq && w.ackedAtVer === undefined) {
              w.ackedAtVer = meta.ver;
              w.ackedBootId = snapBoot;
            }
          }
        }
      }
    }
  };

  const setLocalDraft = (
    key: string,
    value: string,
    opts?: { dirty?: boolean; baseServerText?: string },
  ): void => {
    if (!key) return;
    setLocalDrafts(prev => {
      const existing = prev[key];
      const baseServerText =
        opts?.baseServerText ??
        existing?.baseServerText ??
        st.prevServerDrafts[key] ??
        untrack(() => fleet()?.drafts[key] ?? "");
      const dirty = opts?.dirty ?? true;
      if (
        existing &&
        existing.text === value &&
        existing.baseServerText === baseServerText &&
        existing.dirty === dirty
      ) {
        return prev;
      }
      return { ...prev, [key]: { text: value, baseServerText, dirty } };
    });
  };

  const enqueueDraftOp = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const prev = draftOpChain.get(key) ?? Promise.resolve();
    const next = prev.then(work, work);
    const tail = next.then(
      () => {
        if (draftOpChain.get(key) === tail) draftOpChain.delete(key);
      },
      () => {
        if (draftOpChain.get(key) === tail) draftOpChain.delete(key);
      },
    );
    draftOpChain.set(key, tail);
    return next;
  };

  return {
    st,
    latestQueuedDraft,
    latestQueuedDraftSeq,
    latestQueuedSavePromise,
    lastQueuedSaveTarget,
    reservedSaveEntries,
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
    observedSendOutcomes,
    preRestartEchoes,
    pendingBootRebaseKeys,
    reconciledOnActiveBoot,
    inspectIncomingBootId,
    getKnownServerDraftVer,
    needsKeyBootRebase,
    resolveLocalCommittedSeq,
    addPendingWrite,
    removePendingWrite,
    latchCommittedFirstChunk,
    getMaxCommittedClearSeq,
    getEligiblePendingEchoSet,
    getEligibleAckedEchoSet,
    getEligibleLastAckedSave,
    clearAckedEchoState,
    recordAckedEcho,
    consumeMatchedEcho,
    harvestSendEvidenceFromSnapshot,
    setLocalDraft,
    enqueueDraftOp,
  };
}

export type Watermarks = ReturnType<typeof createWatermarks>;
