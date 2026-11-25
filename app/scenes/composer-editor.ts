// Pure codepoint-accurate multi-line cursor layout & editing engine for `ComposerDrawer`.
// Ensures `Fn+F/X/Z/C` (`ArrowUp/Down/Left/Right`), `Backspace`, `Delete`, Pinyin commits,
// and Doubao voice ASR work naturally on 320x170 without hiding or jumping text.

import { measure, type Slot } from "@pocketjs/framework/compact/primitives";

export interface DraftVisualLine {
  text: string;
  start: number;
  end: number;
  softWrap: boolean;
}

export interface DraftCursorLayout {
  lines: DraftVisualLine[];
  cursor: number;
  cursorRow: number;
  cursorX: number;
  totalChars: number;
}

/** Clamp a codepoint cursor index into `[0, chars.length]`. */
export function clampCursor(draft: string, cursor: number): number {
  const len = Array.from(draft).length;
  return Math.max(0, Math.min(len, Math.floor(cursor)));
}

/** Insert `inserted` at codepoint `cursor`, returning updated `{ text, cursor }`. */
export function insertAtCursor(
  draft: string,
  cursor: number,
  inserted: string,
): { text: string; cursor: number } {
  const chars = Array.from(draft);
  const ins = Array.from(inserted);
  const pos = Math.max(0, Math.min(chars.length, Math.floor(cursor)));
  if (ins.length === 0) return { text: draft, cursor: pos };
  const next = [...chars.slice(0, pos), ...ins, ...chars.slice(pos)].join("");
  return { text: next, cursor: pos + ins.length };
}

/** Delete one codepoint backward (`Backspace`) or forward (`Delete`) around `cursor`. */
export function deleteAtCursor(
  draft: string,
  cursor: number,
  dir: "back" | "forward",
): { text: string; cursor: number } {
  const chars = Array.from(draft);
  const pos = Math.max(0, Math.min(chars.length, Math.floor(cursor)));
  if (dir === "back") {
    if (pos <= 0) return { text: draft, cursor: 0 };
    chars.splice(pos - 1, 1);
    return { text: chars.join(""), cursor: pos - 1 };
  }
  if (pos >= chars.length) return { text: draft, cursor: chars.length };
  chars.splice(pos, 1);
  return { text: chars.join(""), cursor: pos };
}

/** Wrap `draft` into visual rows with exact `[start, end]` codepoint spans and locate `(cursorRow, cursorX)`. */
export function layoutDraftWithCursor(
  draft: string,
  rawCursor: number,
  slot: Slot,
  maxWidth: number,
): DraftCursorLayout {
  const chars = Array.from(draft);
  const totalChars = chars.length;
  const cursor = Math.max(0, Math.min(totalChars, Math.floor(rawCursor)));

  if (totalChars === 0) {
    return {
      lines: [{ text: "", start: 0, end: 0, softWrap: false }],
      cursor: 0,
      cursorRow: 0,
      cursorX: 0,
      totalChars: 0,
    };
  }

  const lines: DraftVisualLine[] = [];
  let lineStart = 0;
  let curText = "";

  for (let i = 0; i < totalChars; i++) {
    const ch = chars[i]!;
    if (ch === "\n") {
      lines.push({ text: curText, start: lineStart, end: i, softWrap: false });
      lineStart = i + 1;
      curText = "";
      continue;
    }
    const candidate = curText + ch;
    if (curText.length > 0 && measure(candidate, slot) > maxWidth) {
      lines.push({ text: curText, start: lineStart, end: i, softWrap: true });
      lineStart = i;
      curText = ch;
    } else {
      curText = candidate;
    }
  }
  lines.push({ text: curText, start: lineStart, end: totalChars, softWrap: false });

  let cursorRow = lines.length - 1;
  for (let r = 0; r < lines.length; r++) {
    const ln = lines[r]!;
    const maxExclusive = ln.softWrap ? ln.end - 1 : ln.end;
    if (cursor >= ln.start && cursor <= maxExclusive) {
      cursorRow = r;
      break;
    }
  }

  const activeLine = lines[cursorRow]!;
  const prefix = chars.slice(activeLine.start, Math.min(cursor, activeLine.end)).join("");
  const cursorX = Math.min(maxWidth, Math.ceil(measure(prefix, slot)));

  return { lines, cursor, cursorRow, cursorX, totalChars };
}

/** Move `cursor` vertically by `dir` (`-1` up, `+1` down) to the closest X column on the target visual line. */
export function moveCursorVertical(
  draft: string,
  layout: DraftCursorLayout,
  dir: -1 | 1,
  slot: Slot,
  preferredX?: number | null,
): { cursor: number; movedRow: boolean; targetX: number } {
  const targetX = preferredX ?? layout.cursorX;
  const nextRow = layout.cursorRow + dir;
  if (nextRow < 0) {
    if (layout.cursor > 0) return { cursor: 0, movedRow: true, targetX: 0 };
    return { cursor: 0, movedRow: false, targetX };
  }
  if (nextRow >= layout.lines.length) {
    if (layout.cursor < layout.totalChars) {
      return { cursor: layout.totalChars, movedRow: true, targetX };
    }
    return { cursor: layout.totalChars, movedRow: false, targetX };
  }

  const chars = Array.from(draft);
  const ln = layout.lines[nextRow]!;
  const maxIdx = ln.softWrap ? Math.max(ln.start, ln.end - 1) : ln.end;

  let bestIdx = ln.start;
  let bestDist = Math.abs(targetX);
  let prefix = "";
  for (let idx = ln.start + 1; idx <= maxIdx; idx++) {
    prefix += chars[idx - 1] ?? "";
    const x = measure(prefix, slot);
    const dist = Math.abs(x - targetX);
    if (dist <= bestDist) {
      bestDist = dist;
      bestIdx = idx;
    } else {
      break;
    }
  }

  return { cursor: bestIdx, movedRow: true, targetX };
}
