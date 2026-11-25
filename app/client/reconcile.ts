// Pure 3-way draft reconciliation for normal snapshots/inline replies and engine restart rebases.

export interface LocalDraftEntry {
  text: string;
  baseServerText: string;
  dirty: boolean;
}

export interface ReconcileDraftInput {
  oldSrv: string;
  newSrv: string;
  entry: LocalDraftEntry | undefined;
  lastAckedSave: string | undefined;
  pendingEchoes: ReadonlySet<string> | undefined;
  ackedEchoes?: ReadonlySet<string> | undefined;
}

export interface ReconcileDraftResult {
  isEcho: boolean;
  nextEntry: LocalDraftEntry | undefined;
  bumped: boolean;
  needsSave: boolean;
}

/** Pure reconciliation of a server `fleet.drafts[key]` transition against local state:
 *  1. Suppresses echoes of our own in-flight cumulative chunk prefixes or acknowledged writes.
 *  2. Extracts external additions (e.g. ASR dictation) relative to the LONGEST matching known base
 *     (`oldSrv`, `lastAckedSave`, `entry.baseServerText`, and in-flight `pendingEchoes`). */
export function reconcileServerDraftUpdate(input: ReconcileDraftInput): ReconcileDraftResult {
  const { oldSrv, newSrv, entry, lastAckedSave, pendingEchoes, ackedEchoes } = input;
  const isEcho =
    (lastAckedSave !== undefined && newSrv === lastAckedSave) ||
    Boolean(pendingEchoes && pendingEchoes.has(newSrv)) ||
    Boolean(ackedEchoes && ackedEchoes.has(newSrv));

  if (isEcho) {
    if (!entry) {
      return { isEcho: true, nextEntry: undefined, bumped: false, needsSave: false };
    }
    const clean = entry.text === newSrv;
    return {
      isEcho: true,
      nextEntry: { text: entry.text, baseServerText: newSrv, dirty: !clean },
      bumped: false,
      needsSave: false,
    };
  }

  if (!entry || !entry.dirty) {
    return {
      isEcho: false,
      nextEntry: { text: newSrv, baseServerText: newSrv, dirty: false },
      bumped: true,
      needsSave: false,
    };
  }

  const candidates: Array<string | undefined> = [oldSrv, lastAckedSave, entry.baseServerText];
  if (pendingEchoes) {
    for (const echo of pendingEchoes) candidates.push(echo);
  }
  if (ackedEchoes) {
    for (const echo of ackedEchoes) candidates.push(echo);
  }
  let bestBase: string | null = null;
  for (const cand of candidates) {
    if (cand === undefined) continue;
    if (newSrv.startsWith(cand) && (bestBase === null || cand.length > bestBase.length)) {
      bestBase = cand;
    }
  }

  const added = bestBase !== null ? newSrv.slice(bestBase.length) : newSrv;
  const merged = added.length > 0 ? entry.text + added : entry.text;
  const dirty = merged !== newSrv;

  return {
    isEcho: false,
    nextEntry: { text: merged, baseServerText: newSrv, dirty },
    bumped: true,
    needsSave: dirty,
  };
}

/** Reconciles a pane draft across an engine `bootId` restart: adopts the new server draft as
 *  baseline while preserving unsent local edits and deduplicating persisted pre-restart saves. */
export function reconcileRestartDraft(
  oldSrv: string,
  newSrv: string,
  entry: LocalDraftEntry | undefined,
  preRestartEchoes: ReadonlySet<string> | undefined,
  inFlightFullText: string | undefined,
): { nextEntry: LocalDraftEntry; bumped: boolean; needsSave: boolean } {
  if (!entry || !entry.dirty) {
    return {
      nextEntry: { text: newSrv, baseServerText: newSrv, dirty: false },
      bumped: newSrv !== (entry?.text ?? oldSrv),
      needsSave: false,
    };
  }

  const exactKnownMatch =
    newSrv === oldSrv ||
    newSrv === entry.baseServerText ||
    Boolean(preRestartEchoes?.has(newSrv)) ||
    (inFlightFullText !== undefined && newSrv === inFlightFullText);

  let merged = entry.text;
  let bumped = false;
  if (!exactKnownMatch && newSrv !== "") {
    const cands = [oldSrv, entry.baseServerText, ...(preRestartEchoes ?? [])];
    let best = "";
    for (const c of cands) {
      if (c && newSrv.startsWith(c) && c.length > best.length) {
        best = c;
      }
    }
    const suffix = newSrv.slice(best.length);
    if (suffix.length > 0) {
      merged = entry.text + suffix;
      bumped = true;
    }
  }

  const dirty = merged !== newSrv;
  return {
    nextEntry: { text: merged, baseServerText: newSrv, dirty },
    bumped,
    needsSave: dirty,
  };
}
