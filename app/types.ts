// Authoritative JSON wire contract between Rust `RexZeroEngine` (`http://zero/rex/*`)
// and Solid TSX UI (`app/`). Keep Rust `src/rex/types.rs` 1:1 aligned with this file.

export type HostKind = "local" | "tailnet" | "ssh" | "tcp";
export type ConnPhase = "idle" | "connecting" | "live" | "reconnecting" | "failed";
export type PathKind = "local" | "direct" | "relay" | "derp" | "ssh" | "tcp";
export type PaneActivityStatus =
  | "blocked"
  | "error"
  | "unseen_done"
  | "running"
  | "done"
  | "idle";

export interface SessionSummary {
  id: string;
  label: string;
  windowCount: number;
  paneCount: number;
}

export interface HostState {
  id: string;
  label: string;
  kind: HostKind;
  endpoint: string;
  phase: ConnPhase;
  problem?: string | null;
  latencyMs?: number | null;
  pathKind?: PathKind | null;
  sessions: SessionSummary[];
}

export interface PaneSummary {
  /** Stable composite key: `${hostId}|${sessionId}|${blockId}` */
  key: string;
  hostId: string;
  hostLabel: string;
  sessionId: string;
  sessionLabel: string;
  windowId: string;
  windowLabel: string;
  blockId: string;
  title: string;
  program: string;
  pwd: string;
  status: PaneActivityStatus;
  statusKind?: string | null;
  statusMsg?: string | null;
  ownedByUs: boolean;
  releasedByUs: boolean;
  hasDraft: boolean;
  updatedAtMs: number;
}

export interface AttentionSummary {
  blockedCount: number;
  errorCount: number;
  unseenDoneCount: number;
  nextTargetKey: string | null;
  chimeSeq: number;
  chimeKind: "approval" | "error" | "done" | "none";
  muted: boolean;
}

export interface TailnetPeer {
  hostName: string;
  dnsName: string;
  ips: string[];
  online: boolean;
  pathKind?: PathKind | null;
  latencyMs?: number | null;
  rexEndpoint?: string | null;
  alreadyAdded: boolean;
}

export interface TailnetState {
  enabled: boolean;
  backendState: string;
  authUrl: string;
  qrMatrix: boolean[][] | null;
  tailnetName: string;
  selfDns: string;
  proxyPort: number;
  error?: string | null;
  peers: TailnetPeer[];
}

export interface ImeStatus {
  available: boolean;
  engine: "librime" | "builtin";
  schema: "pinyin_simp" | "double_pinyin";
}

export type AsrProviderId =
  | "doubao_free"
  | "plugin"
  | "doubao"
  | "openai"
  | "groq"
  | "elevenlabs";

export interface AsrState {
  configured: boolean;
  provider: AsrProviderId;
  recording: boolean;
  busy: boolean;
  targetKey: string | null;
  partial: string;
  level: number;
  error?: string | null;
}

export interface PairState {
  active: boolean;
  url: string;
  pin: string;
  expiresInSec: number;
  qrMatrix: boolean[][] | null;
  pendingImport?: {
    summary: string;
    fromIp: string;
    token: string;
  } | null;
}

export interface DraftMeta {
  ver: number;
  clientId?: string | null;
  clientSeq?: number;
  reservationRolledBack?: boolean;
  provisional?: boolean;
  unpersisted?: boolean;
}

export interface SendOutcome {
  ok: boolean;
  draftCleared?: boolean | null;
  draftVer?: number;
  persistError?: string | null;
}

export interface FleetSnapshot {
  bootId?: string;
  revision: number;
  batteryPercent: number | null;
  charging: boolean;
  hosts: HostState[];
  panes: PaneSummary[];
  attention: AttentionSummary;
  tailnet: TailnetState;
  ime: ImeStatus;
  asr: AsrState;
  pair: PairState;
  drafts: Record<string, string>;
  draftMeta?: Record<string, DraftMeta>;
  sendOutcomes?: Record<string, SendOutcome>;
  fontPreset?: number;
  readerMode?: "chat" | "raw";
  mock: boolean;
}

export interface ApprovalOption {
  key: string;
  label: string;
  send: string;
}

export interface ApprovalCard {
  title: string;
  detail: string;
  options: ApprovalOption[];
}

export interface ReaderMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  title?: string | null;
  body: string;
}

export interface VtSpan {
  t: string;
  fg?: string | null;
  bg?: string | null;
  b?: boolean;
  inv?: boolean;
  u?: boolean;
}

export interface VtViewport {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  scrollOffset: number;
  scrollTotal: number;
  altScreen: boolean;
  lines: VtSpan[][];
}

export interface PaneViewPayload {
  key: string;
  revision: number;
  title: string;
  windowLabel?: string;
  hostLabel: string;
  sessionLabel: string;
  program: string;
  pwd: string;
  streamPhase: ConnPhase;
  streamProblem?: string | null;
  ownedByUs: boolean;
  releasedByUs: boolean;
  status: PaneActivityStatus;
  statusKind?: string | null;
  statusMsg?: string | null;
  liveActivityText?: string | null;
  approval?: ApprovalCard | null;
  readerMessages: ReaderMessage[];
  rawLines?: string[];
  vt: VtViewport;
}

export interface ImeComposeReply {
  raw: string;
  preedit: string;
  candidates: string[];
  committed?: string | null;
  page: number;
  hasMore: boolean;
  schema: "pinyin_simp" | "double_pinyin";
}

export type RexAction =
  | {
      op: "send_input";
      key: string;
      data: string;
      clearDraft?: boolean;
      stage?: boolean;
      resetStage?: boolean;
      stageId?: string;
      ifDraftVer?: number;
      ifBootId?: string;
      clientId?: string;
      clientSeq?: number;
    }
  | { op: "send_key"; key: string; keyName: string; mods?: number }
  | { op: "set_ownership"; key: string; mode: "peek" | "take" | "hand_back"; cols?: number; rows?: number }
  | { op: "scroll_vt"; key: string; deltaLines: number; toBottom?: boolean }
  | {
      op: "save_draft";
      key: string;
      text: string;
      append?: boolean;
      reserveBytes?: number;
      ifDraftVer?: number;
      ifBootId?: string;
      clientId?: string;
      clientSeq?: number;
    }
  | { op: "mark_seen"; key: string }
  | { op: "toggle_mute" }
  | { op: "new_session"; hostId: string; label?: string; cwd?: string }
  | { op: "close_block"; key: string }
  | { op: "add_host"; label: string; endpoint: string; sshKeyPath?: string }
  | { op: "remove_host"; hostId: string }
  | {
      op: "ime_compose";
      raw: string;
      selectIdx?: number;
      pageDelta?: number;
      toggleSchema?: boolean;
    }
  | { op: "asr_toggle"; key: string }
  | { op: "asr_cancel" }
  | { op: "leave_pane" }
  | { op: "asr_configure"; provider: string; apiKey: string; appId?: string; endpoint?: string }
  | { op: "tsnet_set"; enabled: boolean; hostname?: string; authKey?: string }
  | { op: "tsnet_ping"; peerIp: string }
  | { op: "tsnet_add_peer"; dnsName: string; hostName: string; mode: "https" | "ssh"; sshUser?: string }
  | { op: "pair_toggle"; active: boolean }
  | { op: "pair_confirm"; approve: boolean; token?: string }
  | { op: "set_ui_prefs"; fontPreset?: number; readerMode?: "chat" | "raw" };

export interface ActionReply {
  ok: boolean;
  error?: string | null;
  ime?: ImeComposeReply | null;
  createdKey?: string | null;
  revision?: number;
  draftVer?: number;
  clientId?: string | null;
  clientSeq?: number;
  draftCleared?: boolean;
  conflict?: boolean;
  reservationRolledBack?: boolean;
  provisional?: boolean;
  serverDraft?: string | null;
  persistError?: string | null;
  unconfirmed?: boolean;
  bootId?: string;
}
