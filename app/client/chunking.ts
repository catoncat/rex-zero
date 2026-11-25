// WireCall 1020-byte framing limits, JSON byte accounting, and Unicode codepoint-safe chunking.

import type { RexAction } from "../types.ts";
import { RECORD_BYTES, utf8, type WireCall } from "../wire.ts";
import { BASE_URL } from "./ring-http.ts";

export const MAX_WIRE_JSON_BYTES = RECORD_BYTES - 4;
export const MAX_STAGED_INPUT_BYTES = 64 * 1024;
export const MAX_PANE_DRAFT_BYTES = 16 * 1024;
export const MAX_TOTAL_DRAFTS_BYTES = 96 * 1024;

export function draftJsonEscapedBytes(str: string): number {
  let total = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0)!;
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x0a ||
      code === 0x0d ||
      code === 0x09 ||
      code === 0x08 ||
      code === 0x0c
    ) {
      total += 2;
    } else if (code <= 0x1f) {
      total += 6;
    } else if (code <= 0x7f) {
      total += 1;
    } else if (code <= 0x7ff) {
      total += 2;
    } else if (code <= 0xffff) {
      total += 3;
    } else {
      total += 4;
    }
  }
  return total;
}

export function draftEntryEscapedBytes(key: string, value: string): number {
  return 6 + draftJsonEscapedBytes(key) + draftJsonEscapedBytes(value);
}

export function makeActionWireCall(action: RexAction): WireCall {
  return {
    url: `${BASE_URL}/rex/action`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
    timeoutMs: 12_000,
    maxBytes: 256 * 1024,
  };
}

/** Split `input` by Unicode code points so every encoded `WireCall` fits inside `maxEncodedBytes` (<=1020),
 *  accounting for double JSON escaping of quotes, backslashes, and control characters inside `call.body`. */
export function splitForWireCall(
  input: string,
  buildCall: (chunk: string, index: number, isLast: boolean) => WireCall,
  maxEncodedBytes = MAX_WIRE_JSON_BYTES,
): string[] {
  if (input.length === 0) {
    const emptyCall = buildCall("", 0, true);
    if (utf8(JSON.stringify(emptyCall)).length > maxEncodedBytes) {
      throw new RangeError("WireCall envelope exceeds maxEncodedBytes even with empty payload");
    }
    return [""];
  }

  const chars = Array.from(input);
  const chunks: string[] = [];
  let pos = 0;

  while (pos < chars.length) {
    const idx = chunks.length;
    const rest = chars.slice(pos).join("");
    if (utf8(JSON.stringify(buildCall(rest, idx, true))).length <= maxEncodedBytes) {
      chunks.push(rest);
      break;
    }

    let lo = 1;
    let hi = chars.length - pos - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const slice = chars.slice(pos, pos + mid).join("");
      const size = utf8(JSON.stringify(buildCall(slice, idx, false))).length;
      if (size <= maxEncodedBytes) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (best === 0) {
      throw new RangeError("Single Unicode scalar cannot fit inside WireCall maxEncodedBytes");
    }
    chunks.push(chars.slice(pos, pos + best).join(""));
    pos += best;
  }

  return chunks;
}

export function buildSaveDraftChunks(
  key: string,
  fullText: string,
  clientId: string,
  expectedStartVer: number | undefined,
  expectedBootId: string | undefined,
): string[] {
  const bootAttr = expectedBootId ? { ifBootId: expectedBootId } : {};
  return splitForWireCall(fullText, (chunk, idx) =>
    makeActionWireCall(
      idx === 0
        ? {
            op: "save_draft",
            key,
            text: chunk,
            reserveBytes: MAX_TOTAL_DRAFTS_BYTES,
            ...(expectedStartVer !== undefined
              ? {
                  ifDraftVer: Number.MAX_SAFE_INTEGER,
                  clientId,
                  clientSeq: Number.MAX_SAFE_INTEGER,
                }
              : {}),
            ...bootAttr,
          }
        : {
            op: "save_draft",
            key,
            text: chunk,
            append: true,
            ifDraftVer: Number.MAX_SAFE_INTEGER,
            ...bootAttr,
            clientId,
            clientSeq: Number.MAX_SAFE_INTEGER,
          },
    ),
  );
}

export function buildStagedSendPlan(
  key: string,
  data: string,
  clearDraft: boolean | undefined,
  clientId: string,
  stageId: string,
  lockedVer: number | undefined,
  bootAttr: { ifBootId?: string },
  verFields: Record<string, unknown>,
): { chunks: string[]; buildCommit: (chunk: string, probe?: boolean) => RexAction } {
  const probeId = `${clientId}-${Number.MAX_SAFE_INTEGER}`;
  const probeVer = clearDraft
    ? lockedVer !== undefined
      ? {
          ifDraftVer: Number.MAX_SAFE_INTEGER,
          ...bootAttr,
          clientId,
          clientSeq: Number.MAX_SAFE_INTEGER,
        }
      : { ...bootAttr, clientId, clientSeq: Number.MAX_SAFE_INTEGER }
    : {};
  const buildCommit = (chunk: string, probe = false): RexAction =>
    clearDraft === undefined
      ? { op: "send_input", key, data: chunk, stageId: probe ? probeId : stageId }
      : ({
          op: "send_input",
          key,
          data: chunk,
          clearDraft,
          stageId: probe ? probeId : stageId,
          ...(probe ? probeVer : verFields),
        } as RexAction);
  const chunks = splitForWireCall(data, (chunk, idx, isLast) =>
    makeActionWireCall(
      isLast
        ? buildCommit(chunk, true)
        : ({
            op: "send_input",
            key,
            data: chunk,
            stage: true,
            resetStage: idx === 0,
            stageId: probeId,
            ...(idx === 0 ? probeVer : {}),
          } as RexAction),
    ),
  );
  return { chunks, buildCommit };
}
