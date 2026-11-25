// Chunked `saveDraft` pipeline with 16KiB/96KiB byte budgets and CAS conflict progression.

import { untrack, type Accessor, type Setter } from "solid-js";
import type { ActionReply, RexAction } from "../types.ts";
import { utf8 } from "../wire.ts";
import {
  MAX_PANE_DRAFT_BYTES,
  MAX_TOTAL_DRAFTS_BYTES,
  buildSaveDraftChunks,
  draftEntryEscapedBytes,
} from "./chunking.ts";
import type { LocalDraftEntry } from "./reconcile.ts";
import type { RawHttpTransport } from "./ring-http.ts";
import type { SnapshotSync } from "./snapshot-sync.ts";
import type { Watermarks } from "./watermarks.ts";

export interface SaveDraftDeps {
  clientId: string;
  ensureHttp: () => RawHttpTransport;
  wm: Watermarks;
  snapSync: SnapshotSync;
  localDrafts: Accessor<Record<string, LocalDraftEntry>>;
  setExternalDraftSeqs: Setter<Record<string, number>>;
  isSending: (key: string) => boolean;
}

export function createSaveDraft(deps: SaveDraftDeps) {
  const { clientId, ensureHttp, wm, snapSync, localDrafts, setExternalDraftSeqs, isSending } = deps;
  const {
    st,
    latestQueuedDraft,
    latestQueuedDraftSeq,
    latestQueuedSavePromise,
    lastQueuedSaveTarget,
    reservedSaveEntries,
    failedSaveKeys,
    inFlightWrites,
    pendingClearEcho,
    activeSendSessions,
    inFlightSaveCounts,
    activeSaveOps,
    serverChangeSeq,
    serverDraftVer,
    serverAppliedClientSeq,
    lastKeyAppliedRevision,
  } = wm;

  const postRawActionDetailed = async (
    action: RexAction,
  ): Promise<{ reply: ActionReply; transportFailed: boolean; retiredBoot: boolean }> => {
    try {
      const reply = await ensureHttp()<ActionReply>("/rex/action", "POST", action, 12_000, 256 * 1024);
      return { reply, transportFailed: false, retiredBoot: wm.inspectIncomingBootId(reply.bootId) === "retired" };
    } catch (err) {
      return {
        reply: { ok: false, error: err instanceof Error ? err.message : String(err) },
        transportFailed: true,
        retiredBoot: false,
      };
    }
  };

  const postRawAction = async (action: RexAction): Promise<ActionReply> =>
    (await postRawActionDetailed(action)).reply;

  const getPendingWriteAckedVer = (key: string, seq: number): number | undefined => {
    const w = seq > 0 ? inFlightWrites.get(key)?.find(item => item.seq === seq) : undefined;
    if (!w || w.ackedAtVer === undefined) return undefined;
    if (w.ackedBootId !== undefined && st.activeEngineBootId !== undefined && w.ackedBootId !== st.activeEngineBootId) {
      return undefined;
    }
    return w.ackedAtVer;
  };

  const saveDraft = (key: string, fullText: string): Promise<ActionReply> => {
    if (!key) return Promise.resolve({ ok: false, error: "missing pane key" });
    if (activeSendSessions.get(key)?.unconfirmedWriteSeq !== undefined) {
      return Promise.resolve({ ok: false, unconfirmed: true, error: "前一条指令发送状态未确认，暂不覆盖草稿" });
    }
    const opSeq = ++st.draftSaveSeq;
    const enqUnreconciled = wm.needsKeyBootRebase(key);
    const enqBaseVer = enqUnreconciled ? 0 : wm.getKnownServerDraftVer(key);
    const enqBootId = enqUnreconciled ? (st.lastRetiredBootId ?? st.activeEngineBootId) : st.activeEngineBootId;
    const enqExtSeq = serverChangeSeq.get(key) ?? 0;
    const enqEpoch = st.engineEpoch;
    wm.setLocalDraft(key, fullText, { dirty: true });
    latestQueuedDraft.set(key, fullText);
    latestQueuedDraftSeq.set(key, opSeq);
    lastQueuedSaveTarget.set(key, fullText);
    failedSaveKeys.delete(key);

    let followupPromise: Promise<ActionReply> | null = null;
    let coalescedToNewer = false;
    let abortedOnRetiredBoot = false;

    const failPreflight = (error: string): ActionReply => {
      if (latestQueuedDraftSeq.get(key) === opSeq) {
        latestQueuedDraft.delete(key);
        latestQueuedDraftSeq.delete(key);
        latestQueuedSavePromise.delete(key);
        lastQueuedSaveTarget.delete(key);
        failedSaveKeys.add(key);
      }
      return { ok: false, error };
    };

    const slotPromise = wm.enqueueDraftOp<ActionReply>(key, async () => {
      if (activeSendSessions.get(key)?.unconfirmedWriteSeq !== undefined) {
        if (latestQueuedDraftSeq.get(key) === opSeq) {
          latestQueuedDraft.delete(key);
          latestQueuedDraftSeq.delete(key);
          latestQueuedSavePromise.delete(key);
          lastQueuedSaveTarget.delete(key);
        }
        return { ok: false, unconfirmed: true, error: "前一条指令发送状态未确认，暂不覆盖草稿" };
      }
      if (latestQueuedDraftSeq.get(key) !== opSeq) {
        coalescedToNewer = true;
        return { ok: true };
      }

      let targetEntryBytes = 0;
      if (fullText === "") {
        pendingClearEcho.delete(key);
      } else {
        if (utf8(fullText).length > MAX_PANE_DRAFT_BYTES) return failPreflight("draft exceeds 16 KiB limit");
        targetEntryBytes = draftEntryEscapedBytes(key, fullText);
        let othersEscaped = 0;
        for (const otherKey of new Set([...Object.keys(st.prevServerDrafts), ...reservedSaveEntries.keys()])) {
          if (otherKey === key) continue;
          const prevVal = st.prevServerDrafts[otherKey] ?? "";
          const prevBytes = prevVal !== "" ? draftEntryEscapedBytes(otherKey, prevVal) : 0;
          othersEscaped += Math.max(prevBytes, reservedSaveEntries.get(otherKey) ?? 0);
        }
        if (2 + othersEscaped + targetEntryBytes > MAX_TOTAL_DRAFTS_BYTES) {
          return failPreflight("drafts exceed 96 KiB total limit");
        }
      }

      const freshWatermark = st.engineEpoch !== enqEpoch || (serverChangeSeq.get(key) ?? 0) === enqExtSeq;
      const unreconciled = wm.needsKeyBootRebase(key);
      const expectedStartVer = unreconciled ? (enqBaseVer ?? 0) : freshWatermark ? wm.getKnownServerDraftVer(key) : enqBaseVer;
      const expectedBootId = unreconciled ? (st.lastRetiredBootId ?? enqBootId) : freshWatermark ? st.activeEngineBootId : enqBootId;

      let chunks: string[];
      try {
        chunks = buildSaveDraftChunks(key, fullText, clientId, expectedStartVer, expectedBootId);
      } catch (err) {
        return failPreflight(err instanceof Error ? err.message : String(err));
      }

      if (targetEntryBytes > 0) reservedSaveEntries.set(key, targetEntryBytes);
      inFlightSaveCounts.set(key, (inFlightSaveCounts.get(key) ?? 0) + 1);
      let lastReply: ActionReply = { ok: true };
      let requeueText: string | null = null;
      try {
        let cumulative = "";
        let prevChunkVer = expectedStartVer;
        let prevChunkBootId = expectedBootId;
        let extAdvanced = false;
        let abortedMidSave = false;
        const reserveAttr = chunks.length > 1 && targetEntryBytes > 0 ? { reserveBytes: targetEntryBytes } : {};

        for (let i = 0; i < chunks.length; i++) {
          cumulative += chunks[i]!;
          const writeSeq = wm.addPendingWrite(key, cumulative, cumulative === "");
          if (i === 0) activeSaveOps.set(key, { opSeq, fullText, firstChunkSeq: writeSeq, firstChunkAcked: false });
          const bootAttr = prevChunkBootId ? { ifBootId: prevChunkBootId } : {};
          const verAttr = prevChunkVer !== undefined ? { ifDraftVer: prevChunkVer, clientId, clientSeq: writeSeq } : {};
          const part: RexAction =
            i === 0
              ? { op: "save_draft", key, text: chunks[i]!, ...reserveAttr, ...verAttr, ...bootAttr }
              : { op: "save_draft", key, text: chunks[i]!, append: true, ...verAttr, ...bootAttr };

          const extSeqBefore = serverChangeSeq.get(key) ?? 0;
          const epochBefore = st.engineEpoch;
          let ackedChunkVer: number | undefined;
          let chunkRetiredBoot = false;
          let chunkTransportFailed = false;
          try {
            const detailed = await postRawActionDetailed(part);
            lastReply = detailed.reply;
            chunkRetiredBoot = detailed.retiredBoot;
            chunkTransportFailed = detailed.transportFailed;
          } finally {
            ackedChunkVer = getPendingWriteAckedVer(key, writeSeq);
            if (chunkTransportFailed && st.engineEpoch === epochBefore && ackedChunkVer !== undefined) {
              wm.recordAckedEcho(key, cumulative, i === 0, ackedChunkVer);
            }
            wm.removePendingWrite(key, writeSeq);
          }

          if (chunkRetiredBoot || (chunkTransportFailed && st.engineEpoch !== epochBefore)) {
            abortedOnRetiredBoot = true;
            extAdvanced = true;
            abortedMidSave = true;
            lastReply = { ok: true };
            break;
          }

          if (lastReply.conflict) {
            const verBefore = wm.getKnownServerDraftVer(key) ?? prevChunkVer ?? 0;
            if (lastReply.serverDraft !== undefined && lastReply.serverDraft !== null) {
              snapSync.ingestInlineServerDraft(
                key, lastReply.serverDraft, lastReply.revision, lastReply.draftVer, lastReply.clientId, lastReply.clientSeq,
                Boolean(lastReply.reservationRolledBack), Boolean(lastReply.provisional),
              );
            }
            wm.clearAckedEchoState(key);
            const knownAfter = wm.getKnownServerDraftVer(key);
            const nextBoot = wm.needsKeyBootRebase(key) ? (st.lastRetiredBootId ?? st.activeEngineBootId) : st.activeEngineBootId;
            const bootAdv = prevChunkBootId !== undefined && nextBoot !== undefined && prevChunkBootId !== nextBoot;
            const verAdv = prevChunkVer === undefined ? knownAfter !== undefined : knownAfter !== undefined && knownAfter > Math.max(prevChunkVer, verBefore);
            if (!(st.engineEpoch !== epochBefore || bootAdv || verAdv)) {
              return failPreflight(lastReply.error || "draft conflict version did not advance");
            }
            extAdvanced = true;
            abortedMidSave = true;
            break;
          }

          const extChanged = (serverChangeSeq.get(key) ?? 0) !== extSeqBefore;
          if (extChanged) extAdvanced = true;
          const activeOp = activeSaveOps.get(key);

          if (lastReply.draftVer !== undefined) {
            st.hasServerDraftMeta = true;
            const knownVer = serverDraftVer.get(key) ?? 0;
            if (activeOp && i === 0 && (!serverDraftVer.has(key) || lastReply.draftVer >= knownVer)) activeOp.firstChunkAcked = true;
            const sendSess = activeSendSessions.get(key);
            if (sendSess && !sendSess.extChanged && !wm.needsKeyBootRebase(key)) {
              sendSess.lockedDraftVer = lastReply.draftVer;
              sendSess.lockedBootId = st.activeEngineBootId;
            }
            if (!serverDraftVer.has(key) || lastReply.draftVer > knownVer) {
              serverDraftVer.set(key, lastReply.draftVer);
              const cSeq = lastReply.clientId === undefined || lastReply.clientId === clientId ? (lastReply.clientSeq ?? writeSeq) : 0;
              serverAppliedClientSeq.set(key, cSeq);
              const knownRev = lastKeyAppliedRevision.get(key) ?? -1;
              if (!extChanged && (lastReply.revision === undefined || lastReply.revision >= knownRev)) {
                if (lastReply.revision !== undefined) lastKeyAppliedRevision.set(key, Math.max(knownRev, lastReply.revision));
                snapSync.setPrevServerDraft(key, cumulative);
              }
            }
          } else if (lastReply.ok && activeOp && i === 0) {
            activeOp.firstChunkAcked = true;
          }

          if (i === 0 && activeOp?.pendingExternalClear) {
            const pClear = activeOp.pendingExternalClear;
            const sameBoot = pClear.bootId === undefined || st.activeEngineBootId === undefined || pClear.bootId === st.activeEngineBootId;
            const commitVer = lastReply.draftVer ?? ackedChunkVer;
            const ackedEvidence = activeOp.firstChunkAcked || commitVer !== undefined || lastReply.ok;
            const committedBeforeClear = sameBoot && ackedEvidence && (commitVer !== undefined ? pClear.ver === undefined || commitVer < pClear.ver : lastReply.ok && pClear.ver === undefined);
            if (committedBeforeClear) {
              const rem = pClear.strippedPrefix.length > 0 && activeOp.fullText.startsWith(pClear.strippedPrefix)
                ? activeOp.fullText.slice(pClear.strippedPrefix.length)
                : activeOp.fullText;
              const srvAfter = st.prevServerDrafts[key] ?? "";
              const curAfter = untrack(() => localDrafts())[key];
              if (curAfter) {
                const nextText = rem.length > 0 && curAfter.text.startsWith(rem) ? curAfter.text.slice(rem.length) : curAfter.text;
                wm.setLocalDraft(key, nextText, { dirty: nextText !== srvAfter, baseServerText: srvAfter });
                if (nextText !== curAfter.text) setExternalDraftSeqs(prev => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
              }
              if (latestQueuedDraft.has(key)) {
                latestQueuedDraft.delete(key);
                latestQueuedDraftSeq.set(key, opSeq);
              }
              wm.clearAckedEchoState(key);
              if (!lastReply.ok) {
                const curSurv = untrack(() => localDrafts())[key];
                if (curSurv && curSurv.text !== srvAfter && !isSending(key) && !activeSendSessions.has(key) && latestQueuedDraftSeq.get(key) === opSeq) {
                  requeueText = curSurv.text;
                  break;
                }
                return failPreflight(lastReply.error || "draft save failed");
              }
              extAdvanced = true;
              abortedMidSave = true;
              break;
            }
          }

          if (!lastReply.ok) {
            if (lastReply.draftVer !== undefined) {
              wm.recordAckedEcho(key, cumulative, i === 0, lastReply.draftVer);
              const curOnErr = untrack(() => localDrafts())[key];
              if (curOnErr) wm.setLocalDraft(key, curOnErr.text, { dirty: true, baseServerText: st.prevServerDrafts[key] ?? cumulative });
            }
            return failPreflight(lastReply.error || "draft save failed");
          }

          prevChunkVer = lastReply.draftVer;
          prevChunkBootId = lastReply.bootId ?? st.activeEngineBootId;
          const srvNow = st.prevServerDrafts[key] ?? "";
          const curEntry = untrack(() => localDrafts())[key];
          const supersededBySnap = extChanged && curEntry?.baseServerText === srvNow && srvNow !== cumulative && srvNow.startsWith(cumulative);
          if (!supersededBySnap) {
            if (extChanged && i > 0 && lastReply.draftVer === undefined) wm.recordAckedEcho(key, srvNow + chunks[i]!, true);
            else wm.recordAckedEcho(key, cumulative, i === 0, lastReply.draftVer);
          } else {
            wm.clearAckedEchoState(key);
          }
          if (i < chunks.length - 1 && (extChanged || latestQueuedDraftSeq.get(key) !== opSeq)) {
            abortedMidSave = true;
            break;
          }
        }

        if (lastReply.ok || (abortedMidSave && lastReply.conflict)) {
          const cur = untrack(() => localDrafts())[key];
          const srvNow = st.prevServerDrafts[key] ?? "";
          const canRequeue = !isSending(key) && !activeSendSessions.has(key) && latestQueuedDraftSeq.get(key) === opSeq;
          if (abortedMidSave) {
            if (extAdvanced && cur && cur.text !== srvNow && canRequeue) {
              requeueText = cur.text;
            } else if (latestQueuedDraftSeq.get(key) === opSeq) {
              if (!cur || !cur.dirty) {
                lastQueuedSaveTarget.set(key, srvNow);
                failedSaveKeys.delete(key);
                if (lastReply.conflict) lastReply = { ok: true, revision: lastReply.revision, draftVer: lastReply.draftVer };
              } else {
                lastQueuedSaveTarget.delete(key);
              }
            }
          } else if (extAdvanced && cur && cur.baseServerText === srvNow && srvNow !== fullText && srvNow.startsWith(fullText)) {
            wm.setLocalDraft(key, cur.text, { dirty: cur.text !== srvNow, baseServerText: srvNow });
          } else if (extAdvanced && chunks.length > 1) {
            if (cur) {
              wm.setLocalDraft(key, cur.text, { dirty: cur.text !== srvNow, baseServerText: cur.baseServerText });
              if (cur.text !== srvNow && canRequeue) requeueText = cur.text;
            }
          } else if (!cur || cur.text === fullText) {
            wm.setLocalDraft(key, fullText, { dirty: false, baseServerText: fullText });
          } else {
            wm.setLocalDraft(key, cur.text, { dirty: true, baseServerText: fullText });
          }
        }
      } finally {
        reservedSaveEntries.delete(key);
        activeSaveOps.delete(key);
        if (latestQueuedDraftSeq.get(key) === opSeq) {
          latestQueuedDraft.delete(key);
          latestQueuedDraftSeq.delete(key);
          latestQueuedSavePromise.delete(key);
        }
        const rem = (inFlightSaveCounts.get(key) ?? 1) - 1;
        if (rem <= 0) inFlightSaveCounts.delete(key);
        else inFlightSaveCounts.set(key, rem);
      }

      if (requeueText !== null) followupPromise = saveDraft(key, requeueText);
      return lastReply;
    });

    const outerPromise: Promise<ActionReply> = slotPromise.then((reply): ActionReply | Promise<ActionReply> => {
      if (followupPromise && followupPromise !== outerPromise) return followupPromise;
      if (reply.conflict || coalescedToNewer || abortedOnRetiredBoot) {
        const rec = latestQueuedSavePromise.get(key) ?? null;
        if (rec && rec !== outerPromise) return rec;
      }
      return reply;
    });
    latestQueuedSavePromise.set(key, outerPromise);
    return outerPromise;
  };

  return { postRawActionDetailed, postRawAction, saveDraft };
}
