// Pure layout & formatting helpers for Workspace (`阅读` & `终端`) and Approval banner.

import { SLOT, measure, type Slot } from "@pocketjs/framework/compact/primitives";
import type { ApprovalCard, ApprovalOption, PaneActivityStatus, ReaderMessage, VtViewport } from "../types.ts";
import { sanitizeDisplayText, wrapCjk } from "../client.ts";
import { THEME } from "../theme.ts";

export interface VisualLine {
  text: string;
  color: string;
  barColor: string | null;
}

export interface ReaderDoc {
  lines: VisualLine[];
  turnOffsets: number[];
}

export function cleanInlineMarkdown(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "$1");
}

export function cleanOptionLabel(key: string, label: string): string {
  const trimmed = sanitizeDisplayText(label);
  if (!key) return trimmed;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = trimmed.replace(new RegExp(`^(?:\\[${escaped}\\]|${escaped}[\\).:])\\s*`, "i"), "");
  return stripped.length > 0 ? stripped : trimmed;
}

/** Detects wide desktop-only AGY/Claude TUI status/swarm/quota footer bars so they don't eat 8+ rows on 320x170. */
export function isDesktopTuiChromeLine(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  const hasSep = s.includes("|") || s.includes("│");
  if ((s.includes("Swarm(") || s.includes("Swarm (")) && (s.includes("alt+s board") || s.includes("coordinator:") || s.includes(" active"))) {
    return true;
  }
  if (lower.includes("tok/s") && (s.includes("%") || lower.includes("ttft"))) return true;
  if (s.includes("5h ") && s.includes("%") && s.includes("7d ")) return true;
  if ((s.includes("k/1.0M") || s.includes("k/200k")) && s.includes("%")) return true;
  if (hasSep && /S\d+:\S+/.test(s) && (s.includes("Carbon") || s.includes("Neon") || s.includes("Hydrogen"))) return true;
  if (lower.includes("auto mode: edits & safe commands") || lower.includes("bypass permissions on")) return true;
  return false;
}

export function buildReaderDoc(
  messages: readonly ReaderMessage[],
  slot: Slot,
  maxWidth: number,
  status?: PaneActivityStatus,
  liveActivity?: string | null,
): ReaderDoc {
  const lines: VisualLine[] = [];
  const turnOffsets: number[] = [];

  const nonSystem = messages.filter(m => m.role !== "system");
  const effective = nonSystem.length > 0 ? nonSystem : messages;

  const pushBlankOnce = () => {
    if (lines.length > 0 && lines[lines.length - 1]!.text !== "") {
      lines.push({ text: "", color: THEME.text, barColor: null });
    }
  };

  let consecutiveToolLines = 0;

  for (let i = 0; i < effective.length; i++) {
    const msg = effective[i]!;
    const isNearTail = i >= effective.length - 4;

    if (msg.role === "user") {
      consecutiveToolLines = 0;
      const clean = sanitizeDisplayText(msg.body);
      if (!clean) continue;
      pushBlankOnce();
      turnOffsets.push(lines.length);
      const wrapped = wrapCjk(`> ${clean}`, slot, maxWidth);
      for (const ln of wrapped) {
        lines.push({ text: ln, color: THEME.amber, barColor: THEME.amber });
      }
      continue;
    }

    if (msg.role === "tool") {
      if (!isNearTail && consecutiveToolLines >= 3) continue;
      consecutiveToolLines++;
      const title = sanitizeDisplayText(msg.title).replace(/\s*\(ctrl\+o to expand\)\s*$/i, "");
      const body = sanitizeDisplayText(msg.body);
      if (title === "思考") {
        const txt = body ? `· ${body}` : "· 正在思考...";
        const firstLine = wrapCjk(txt, slot, maxWidth)[0];
        if (firstLine) lines.push({ text: firstLine, color: THEME.dim, barColor: null });
      } else {
        const label = body ? `› ${title || "执行"}: ${body}` : `› ${title || "执行工具"}`;
        const firstLine = wrapCjk(label, slot, maxWidth)[0];
        if (firstLine) lines.push({ text: firstLine, color: THEME.cyan, barColor: THEME.cyan });
      }
      continue;
    }

    consecutiveToolLines = 0;

    if (msg.role === "system") {
      const sysBody = sanitizeDisplayText(msg.body);
      if (!sysBody || isDesktopTuiChromeLine(sysBody)) continue;
      for (const ln of wrapCjk(sysBody, slot, maxWidth)) {
        lines.push({ text: ln, color: THEME.muted, barColor: null });
      }
      continue;
    }

    const rawParas = msg.body.split("\n");
    let startedTurn = false;
    let inCodeFence = false;

    for (const rawLine of rawParas) {
      const trimmedEnd = rawLine.replace(/\s+$/, "");
      const trimmed = trimmedEnd.trim();

      if (trimmed.startsWith("```")) {
        inCodeFence = !inCodeFence;
        continue;
      }
      if (!trimmed) {
        if (startedTurn) pushBlankOnce();
        continue;
      }
      if (isDesktopTuiChromeLine(trimmed)) continue;

      if (!startedTurn) {
        pushBlankOnce();
        turnOffsets.push(lines.length);
        startedTurn = true;
      }

      if (inCodeFence || rawLine.startsWith("  ") || trimmed.startsWith("└")) {
        const cleanCode = sanitizeDisplayText(trimmedEnd);
        for (const ln of wrapCjk(cleanCode, slot, maxWidth)) {
          lines.push({ text: ln, color: THEME.muted, barColor: THEME.border });
        }
        continue;
      }

      if (/^[-─━═_=*]{6,}$/.test(trimmed)) {
        pushBlankOnce();
        continue;
      }

      const headingMatch = /^#{1,4}\s+(.*)$/.exec(trimmed);
      if (headingMatch) {
        const hText = cleanInlineMarkdown(sanitizeDisplayText(headingMatch[1]));
        for (const ln of wrapCjk(hText, slot, maxWidth)) {
          lines.push({ text: ln, color: THEME.cyan, barColor: null });
        }
        continue;
      }

      const bulletMatch = /^(?:[-*•])\s+(.*)$/.exec(trimmed);
      if (bulletMatch) {
        const bText = `• ${cleanInlineMarkdown(sanitizeDisplayText(bulletMatch[1]))}`;
        for (const ln of wrapCjk(bText, slot, maxWidth)) {
          lines.push({ text: ln, color: THEME.text, barColor: null });
        }
        continue;
      }

      const cleanPara = cleanInlineMarkdown(sanitizeDisplayText(trimmed));
      for (const ln of wrapCjk(cleanPara, slot, maxWidth)) {
        lines.push({ text: ln, color: THEME.text, barColor: null });
      }
    }
  }

  while (lines.length > 0 && lines[lines.length - 1]!.text === "") {
    lines.pop();
  }

  if (status === "running") {
    const act = sanitizeDisplayText(liveActivity);
    const liveStr = act && !isDesktopTuiChromeLine(act) ? `● ${act}` : "● 正在工作中...";
    const lastTxt = lines[lines.length - 1]?.text ?? "";
    if (!act || !lastTxt.includes(act.slice(0, 12))) {
      pushBlankOnce();
      for (const ln of wrapCjk(liveStr, slot, maxWidth).slice(0, 2)) {
        lines.push({ text: ln, color: THEME.green, barColor: THEME.green });
      }
    }
  }

  return { lines, turnOffsets };
}

const TERM_RULE_RE = /^[-─━═_=*]{8,}$/;

/** Build soft-wrapped, scrollable terminal lines with live PTY cursor (`█`) and desktop-footer de-cluttering. */
export function buildTerminalDoc(
  vt: VtViewport | undefined,
  rawLines: readonly string[] | undefined,
  slot: Slot,
  maxWidth: number,
  showCursor = true,
): VisualLine[] {
  const out: VisualLine[] = [];

  const vtLines = vt?.lines ?? [];
  const cursorRow = vt?.cursorVisible ? vt.cursorY : -1;
  const cursorCol = vt?.cursorVisible ? vt.cursorX : -1;

  const liveRows: { plain: string; display: string; color: string; hasCursor: boolean }[] = [];
  for (let y = 0; y < vtLines.length; y++) {
    const row = vtLines[y]!;
    let rawRow = "";
    let dominantColor: string = THEME.text;
    for (const sp of row) {
      if (!sp.t) continue;
      rawRow += sp.t;
      if (dominantColor === THEME.text && sp.fg && sp.fg.toLowerCase() !== "#ffffff") {
        dominantColor = sp.fg;
      }
    }
    const plain = rawRow.replace(/\s+$/, "");
    let display = plain;
    let hasCursor = false;
    if (showCursor && y === cursorRow && cursorCol >= 0) {
      hasCursor = true;
      const chars = Array.from(plain);
      if (cursorCol < chars.length) {
        chars.splice(cursorCol, 0, "█");
        display = chars.join("");
      } else {
        const padSpaces = cursorCol > chars.length && plain.length > 0 ? " " : "";
        display = `${plain}${padSpaces}█`;
      }
    }
    liveRows.push({ plain, display, color: dominantColor, hasCursor });
  }

  while (liveRows.length > 0 && liveRows[liveRows.length - 1]!.plain.trim() === "" && !liveRows[liveRows.length - 1]!.hasCursor) {
    liveRows.pop();
  }
  while (liveRows.length > 0 && liveRows[0]!.plain.trim() === "" && !liveRows[0]!.hasCursor) {
    liveRows.shift();
  }

  const hist = (rawLines ?? []).map(l => l.replace(/\s+$/, ""));
  while (hist.length > 0 && hist[hist.length - 1]!.trim() === "") {
    hist.pop();
  }

  let histEnd = hist.length;
  if (liveRows.length > 0 && hist.length > 0) {
    const maxK = Math.min(hist.length, liveRows.length, 40);
    for (let k = maxK; k >= 1; k--) {
      let match = true;
      let nonBlank = false;
      for (let j = 0; j < k; j++) {
        const hl = hist[hist.length - k + j]!;
        const ll = liveRows[j]!.plain;
        if (hl !== ll) {
          match = false;
          break;
        }
        if (hl.trim().length > 0) nonBlank = true;
      }
      if (match && nonBlank) {
        histEnd = hist.length - k;
        break;
      }
    }
  }

  const pushTermLine = (raw: string | undefined, color: string, keepPromptCursor = false) => {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) {
      if (out.length > 0 && out[out.length - 1]!.text !== "") {
        out.push({ text: "", color: THEME.muted, barColor: null });
      }
      return;
    }
    if (!keepPromptCursor && isDesktopTuiChromeLine(trimmed)) {
      return;
    }
    if (TERM_RULE_RE.test(trimmed)) {
      if (out.length > 0 && out[out.length - 1]?.text !== "────────────────────────") {
        out.push({ text: "────────────────────────", color: THEME.line, barColor: null });
      }
      return;
    }
    const ln = sanitizeDisplayText(raw).replace(/\s*\(ctrl\+o to expand\)\s*$/i, "");
    if (!ln) return;
    for (const w of wrapCjk(ln, slot, maxWidth)) {
      out.push({ text: w, color: keepPromptCursor ? THEME.cyan : color, barColor: null });
    }
  };

  for (let i = 0; i < histEnd; i++) {
    pushTermLine(hist[i], THEME.muted, false);
  }
  for (const row of liveRows) {
    pushTermLine(row.display, row.color, row.hasCursor);
  }

  while (out.length > 0 && (out[out.length - 1]!.text === "" || out[out.length - 1]!.text === "────────────────────────")) {
    out.pop();
  }
  return out;
}

export interface ApprovalLayout {
  card: ApprovalCard;
  detailLine: string;
  height: number;
  optionsAreaH: number;
  optionBoxes: { x: number; y: number; w: number; label: string; primary: boolean }[];
}

export function layoutApprovalBanner(
  card: ApprovalCard | null | undefined,
  opts: readonly ApprovalOption[],
): ApprovalLayout | null {
  if (!card || opts.length === 0) return null;
  const shown = opts.slice(0, 4);
  const availW = 300;
  const gap = 4;
  const twoRows = shown.length > 3;
  const cols = twoRows ? 2 : shown.length;
  const cellW = Math.floor((availW - gap * (cols - 1)) / cols);
  const rowStep = 18;
  const optionBoxes = shown.map((opt, idx) => {
    const key = opt.key || String(idx + 1);
    const label = `[${key}] ${cleanOptionLabel(key, opt.label)}`;
    const row = twoRows ? Math.floor(idx / 2) : 0;
    const col = twoRows ? idx % 2 : idx;
    const desiredW = Math.ceil(measure(label, SLOT.xsBold)) + 10;
    const w = cols === 1 ? Math.min(availW, desiredW) : cellW;
    return {
      x: 6 + col * (cellW + gap),
      y: row * rowStep,
      w,
      label,
      primary: idx === 0,
    };
  });
  const optionsAreaH = twoRows ? 34 : 16;
  const detailLine = sanitizeDisplayText(card.detail);
  const height = (detailLine ? 36 : 22) + optionsAreaH;
  return { card, detailLine, height, optionsAreaH, optionBoxes };
}
