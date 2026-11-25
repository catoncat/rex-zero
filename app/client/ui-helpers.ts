// Shared UI, keybinding, priority sorting, task-centric card titles, short host aliases,
// CJK line-wrapping, and cross-scene navigation helpers.

import { measure, wrap, type Slot, type Tone } from "@pocketjs/framework/compact/primitives";
import type { HostState, PaneActivityStatus, PaneSummary, TailnetPeer } from "../types.ts";

const UI_CHAR_MAP: Record<string, string> = {
  "π": "π",
  "⇄": "↔",
  "⇆": "↔",
  "⏭": "»",
  "⏩": "»",
  "⏮": "«",
  "⏪": "«",
  "⏯": "▶",
  "⏵": "▶",
  "▸": "▶",
  "❯": "›",
  "⚡": "*",
  "─": "-",
  "━": "-",
  "═": "-",
  "│": "|",
  "┃": "|",
  "║": "|",
  "┌": "+",
  "┐": "+",
  "└": "+",
  "┘": "+",
  "╭": "+",
  "╮": "+",
  "╰": "+",
  "╯": "+",
  "⎿": "|",
  "⏳": "·",
  "⌛": "·",
  "⏱": "·",
  "⏲": "·",
  "✔": "✓",
  "✅": "✓",
  "✖": "✗",
  "❌": "✗",
  "⏺": "●",
  "◉": "●",
  "⬤": "●",
  "✻": "*",
  "✶": "*",
  "✢": "*",
  "✳": "*",
  "\t": " ",
  "\r": " ",
  "\n": " ",
};

/** Strips PUA/NerdFont tofu, astral pictographs, variation selectors, and maps missing symbols to crisp glyphs. */
export function sanitizeDisplayText(raw: string | null | undefined): string {
  if (!raw) return "";
  let out = "";
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0x2028 && cp <= 0x202f) ||
      (cp >= 0x2800 && cp <= 0x28ff) ||
      (cp >= 0xfe00 && cp <= 0xfe0f) ||
      cp === 0xfeff ||
      (cp >= 0xe000 && cp <= 0xf8ff) ||
      cp >= 0xf0000 ||
      (cp >= 0x1f000 && cp <= 0x1faff)
    ) {
      continue;
    }
    out += UI_CHAR_MAP[ch] ?? ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Compact 2-6 char machine alias (`Alice的Mac Mini` -> `mini`, `zero 本机` -> `zero`). */
export function shortHostLabel(hostLabel: string, endpoint?: string, hostId?: string): string {
  const clean = sanitizeDisplayText(hostLabel);
  const ep = (endpoint ?? "").toLowerCase();
  if (hostId === "local" || hostId === "cp0" || /本机|^cp0\b|^zero\b/i.test(clean)) {
    return "zero";
  }
  if (/mac[\s_-]*mini/i.test(clean) || ep.includes("mac-mini")) {
    return "mini";
  }
  if (/mac[\s_-]*studio/i.test(clean) || ep.includes("mac-studio")) {
    return "studio";
  }
  if (/macbook[\s_-]*pro/i.test(clean)) {
    return "mbp";
  }
  if (/macbook[\s_-]*air/i.test(clean)) {
    return "mba";
  }
  let s = clean
    .replace(/^[a-z0-9_.-]+的\s*/i, "")
    .replace(/-rex$/i, "")
    .replace(/\.ts\.net.*$/i, "")
    .trim();
  if (!s) s = hostId || "host";
  if (/^[A-Za-z0-9_.-]+$/.test(s)) {
    s = s.toLowerCase();
  }
  return [...s].slice(0, 7).join("");
}

export function shortenPwd(pwd: string | null | undefined): string {
  const raw = sanitizeDisplayText(pwd);
  if (!raw) return "";
  const homeReplaced = raw
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~");
  if ([...homeReplaced].length <= 24) return homeReplaced;
  const parts = homeReplaced.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return `…/${parts.slice(-2).join("/")}`;
  }
  return homeReplaced;
}

const GENERIC_WINDOW_LABELS = new Set([
  "",
  "tab",
  "window",
  "pane",
  "shell",
  "zsh",
  "bash",
  "fish",
  "sh",
  "tmux",
  "default",
  "main",
  "agent",
  "test",
  "review",
  "telemetry",
]);

export function isGenericWindowLabel(label: string): boolean {
  const clean = sanitizeDisplayText(label).toLowerCase();
  if (GENERIC_WINDOW_LABELS.has(clean)) return true;
  if (/^(?:window|tab|pane|block|session)(?:[:_#-]|\s+[0-9a-f]{4,}$|\s+\d+$)/i.test(clean)) return true;
  if (/^\d+$/.test(clean)) return true;
  return false;
}

export function isShellPromptTitle(title: string): boolean {
  const clean = sanitizeDisplayText(title);
  if (!clean) return true;
  if (/^[a-z0-9._-]+@[a-z0-9._-]+[:\s]/i.test(clean)) return true;
  return GENERIC_WINDOW_LABELS.has(clean.toLowerCase());
}

/** Human task/conversation title for Line 1 of a card (never wastes width on host name or user@host). */
export function primaryPaneTitle(pane: Pick<PaneSummary, "windowLabel" | "title" | "sessionLabel" | "program" | "pwd">): string {
  const win = sanitizeDisplayText(pane.windowLabel);
  const winValid = Boolean(win && !isGenericWindowLabel(win) && !isShellPromptTitle(win));
  if (winValid) {
    return win;
  }
  const title = sanitizeDisplayText(pane.title);
  if (title && !isShellPromptTitle(title) && !isGenericWindowLabel(title)) {
    return title;
  }
  const sess = sanitizeDisplayText(pane.sessionLabel);
  if (sess && !/^session[:_#-]/i.test(sess) && sess.toLowerCase() !== "default") {
    return sess;
  }
  const dir = shortenPwd(pane.pwd);
  const lastSeg = dir.split("/").filter(Boolean).pop() ?? "";
  const prog = sanitizeDisplayText(pane.program) || "shell";
  if (lastSeg && lastSeg !== "~") {
    return `${lastSeg} · ${prog}`;
  }
  return title || prog || win;
}

/** Crisp Line 2 subtitle: `<program> · <statusMsg | title | pwd | sessionLabel>`. */
export function secondaryPaneSubtitle(
  pane: Pick<PaneSummary, "windowLabel" | "title" | "sessionLabel" | "program" | "pwd" | "statusMsg">,
  primary?: string,
): string {
  const usedPrimary = primary ?? primaryPaneTitle(pane);
  const prog = sanitizeDisplayText(pane.program) || "shell";
  const msg = sanitizeDisplayText(pane.statusMsg).replace(/\*\*|`/g, "").trim();
  if (msg) {
    return `${prog} · ${msg}`;
  }
  const title = sanitizeDisplayText(pane.title);
  if (title && title !== usedPrimary && !isShellPromptTitle(title)) {
    return `${prog} · ${title}`;
  }
  const dir = shortenPwd(pane.pwd);
  if (dir) {
    return `${prog} · ${dir}`;
  }
  const sess = sanitizeDisplayText(pane.sessionLabel);
  if (sess && sess !== usedPrimary && !/^session[:_#-]/i.test(sess)) {
    return `${prog} · ${sess}`;
  }
  return prog;
}

/** Compact relative elapsed age for inbox & quick-switch rows. */
export function formatRelativeAge(updatedAtMs: number, nowMs = Date.now()): string {
  if (!updatedAtMs || updatedAtMs <= 0) return "";
  const diffSec = Math.max(0, Math.floor((nowMs - updatedAtMs) / 1000));
  if (diffSec < 15) return "刚刚";
  if (diffSec < 60) return `${diffSec}s`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function isCtrlKey(key: string, target: string): boolean {
  const lower = target.toLowerCase();
  return (
    key === `Control+${lower}` ||
    key === `Control+${lower.toUpperCase()}` ||
    key === `Ctrl+${lower}` ||
    key === `Ctrl+${lower.toUpperCase()}`
  );
}

export function isAltKey(key: string, target: string): boolean {
  const lower = target.toLowerCase();
  return key === `Alt+${lower}` || key === `Alt+${lower.toUpperCase()}`;
}

export function isCtrlSpace(key: string): boolean {
  return key === "Control+ " || key === "Control+Space" || key === "Ctrl+ " || key === "Ctrl+Space";
}

export function isCtrlTab(key: string): boolean {
  return key === "Control+Tab" || key === "Ctrl+Tab";
}

export function isPrintableChar(key: string): boolean {
  if (key.length !== 1) return false;
  const code = key.charCodeAt(0);
  return code >= 0x20 && code <= 0x7e;
}

export interface StatusMeta {
  badge: string;
  shortTag: string;
  color: string;
  tone: Tone;
  priority: number;
}

export function statusMeta(status: PaneActivityStatus): StatusMeta {
  switch (status) {
    case "blocked":
      return { badge: "待批", shortTag: "待批", color: "#ffc857", tone: "accent", priority: 0 };
    case "error":
      return { badge: "报错", shortTag: "报错", color: "#ff7b9c", tone: "warn", priority: 1 };
    case "unseen_done":
      return { badge: "新完", shortTag: "新", color: "#47d7ff", tone: "ok", priority: 2 };
    case "running":
      return { badge: "运行", shortTag: "", color: "#62e2a0", tone: "text", priority: 3 };
    case "done":
      return { badge: "已读", shortTag: "", color: "#505a68", tone: "dim", priority: 4 };
    default:
      return { badge: "空闲", shortTag: "", color: "#505a68", tone: "dim", priority: 5 };
  }
}

export function sortPanesByPriority(panes: readonly PaneSummary[]): PaneSummary[] {
  return [...panes].sort((a, b) => {
    const pa = statusMeta(a.status).priority;
    const pb = statusMeta(b.status).priority;
    if (pa !== pb) return pa - pb;
    return b.updatedAtMs - a.updatedAtMs;
  });
}

/** CJK-safe line wrapper: uses PocketJS `wrap` first, then char-wraps any overly long segment. */
export function wrapCjk(input: string, slot: Slot, maxWidth: number): string[] {
  if (!input) return [""];
  const base = wrap(input, slot, maxWidth);
  const out: string[] = [];
  for (const line of base) {
    if (measure(line, slot) <= maxWidth) {
      out.push(line);
      continue;
    }
    let cur = "";
    for (const ch of line) {
      const next = cur + ch;
      if (cur.length > 0 && measure(next, slot) > maxWidth) {
        out.push(cur);
        cur = ch;
      } else {
        cur = next;
      }
    }
    if (cur.length > 0) out.push(cur);
  }
  return out.length > 0 ? out : [""];
}

type OpenPaneFn = (key: string) => void;
type OpenSettingsFn = (initialTab?: 0 | 1) => void;
type JumpPendingFn = () => boolean;

let navOpenPane: OpenPaneFn | null = null;
let navOpenSettings: OpenSettingsFn | null = null;
let navJumpPending: JumpPendingFn | null = null;

export function registerNavHandlers(
  openPane: OpenPaneFn,
  openSettings: OpenSettingsFn,
  jumpPending: JumpPendingFn,
): void {
  navOpenPane = openPane;
  navOpenSettings = openSettings;
  navJumpPending = jumpPending;
}

export function navigateToPane(key: string): void {
  navOpenPane?.(key);
}

export function navigateToSettings(initialTab: 0 | 1 = 0): void {
  navOpenSettings?.(initialTab);
}

export function jumpToNextPending(): boolean {
  return navJumpPending?.() ?? false;
}

function slugWords(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractEndpointHost(endpoint: string): string {
  const rest = endpoint.trim().toLowerCase().split("://")[1] ?? "";
  const authority = rest.split("/")[0] ?? "";
  const hostPort = authority.split("@").pop() ?? "";
  if (hostPort.startsWith("[")) {
    return (hostPort.slice(1).split("]")[0] ?? "").replace(/\.$/, "");
  }
  return (hostPort.split(":")[0] ?? "").replace(/\.$/, "");
}

function rexNodePrefix(hostName: string, dnsName: string): string | null {
  const firstDns = (dnsName.replace(/\.$/, "").split(".")[0] ?? "").trim().toLowerCase();
  if (firstDns.endsWith("-rex") && firstDns.length > 4) {
    return firstDns.slice(0, -4);
  }
  const hn = hostName.trim();
  if (hn.length > 4 && hn.slice(-4).toLowerCase() === "-rex") {
    const s = slugWords(hn.slice(0, -4));
    if (s) return s;
  }
  return null;
}

function companionKeys(hostName: string, dnsName: string): string[] {
  const rexPfx = rexNodePrefix(hostName, dnsName);
  if (rexPfx) return [rexPfx];
  const keys: string[] = [];
  const firstDns = (dnsName.replace(/\.$/, "").split(".")[0] ?? "").trim().toLowerCase();
  if (firstDns) keys.push(firstDns);
  const nameSlug = slugWords(hostName);
  if (nameSlug && nameSlug !== firstDns) keys.push(nameSlug);
  return keys;
}

export function isRexPeerNode(peer: TailnetPeer): boolean {
  return Boolean(peer.rexEndpoint?.startsWith("http")) || rexNodePrefix(peer.hostName, peer.dnsName) !== null;
}

function isExplicitUserSshEndpoint(ep: string): boolean {
  return ep.startsWith("ssh://") && (ep.slice(6).split("/")[0]?.includes("@") ?? false);
}

export function findMatchingHost(peer: TailnetPeer, hosts: readonly HostState[]): HostState | undefined {
  const dns = peer.dnsName.replace(/\.$/, "").toLowerCase();
  const rexEp = peer.rexEndpoint?.replace(/\/$/, "").toLowerCase() ?? "";
  const peerName = peer.hostName.trim().toLowerCase();
  const rexPeer = isRexPeerNode(peer);
  const peerKeys = companionKeys(peer.hostName, peer.dnsName);

  if (rexEp) {
    const byRexEp = hosts.find(h => h.id !== "local" && h.endpoint.replace(/\/$/, "").toLowerCase() === rexEp);
    if (byRexEp) return byRexEp;
  }

  if (dns) {
    const byDns = hosts.find(h => {
      if (h.id === "local") return false;
      const ep = h.endpoint.toLowerCase();
      if (rexPeer && isExplicitUserSshEndpoint(ep)) return false;
      return extractEndpointHost(ep) === dns;
    });
    if (byDns) return byDns;
  }

  return hosts.find(h => {
    if (h.id === "local") return false;
    const ep = h.endpoint.toLowerCase();
    if (rexPeer && isExplicitUserSshEndpoint(ep)) return false;
    if (peerName && h.label.trim().toLowerCase() === peerName) return true;
    const epHost = extractEndpointHost(ep);
    if (peerKeys.length > 0 && epHost.endsWith(".ts.net")) {
      const hostKeys = companionKeys(h.label, epHost);
      return peerKeys.some(pk => hostKeys.includes(pk));
    }
    return false;
  });
}
