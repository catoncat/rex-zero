import { describe, expect, mock, test } from "bun:test";
import {
  Answer,
  HEADER_BYTES,
  RECORD_BYTES,
  answer,
  decodeCall,
  encodeCall,
  text,
  utf8,
  type WireCall,
} from "../app/wire.ts";
import type {
  ActionReply,
  FleetSnapshot,
  PaneActivityStatus,
  PaneSummary,
  RexAction,
} from "../app/types.ts";

// Mock PocketJS runtime hooks & TSX-backed compact UI barrel so Bun tests can exercise `app/client.ts`.
mock.module("@pocketjs/framework/clock", () => ({
  after: () => () => {},
}));
mock.module("@pocketjs/framework/lifecycle", () => ({
  onFrame: () => {},
}));
mock.module("@pocketjs/framework/worker/channels", () => ({
  worker: {
    channel: () => ({
      publish: () => true,
      observe: () => [],
    }),
  },
}));
mock.module("@pocketjs/framework/compact", () => ({
  measure: (s: string) => s.length * 7,
  toast: () => {},
  wrap: (s: string) => s.split("\n"),
}));
mock.module("@pocketjs/framework/compact/primitives", () => ({
  SLOT: { xs: 0, sm: 1, base: 2, xsBold: 7, smBold: 8, baseBold: 9, tiny: 19, tinyBold: 20 },
  measure: (s: string) => s.length * 7,
  wrap: (s: string) => s.split("\n"),
}));
const { createRexClient, reconcileServerDraftUpdate, splitForWireCall } = await import(
  "../app/client.ts"
);

// Mirror of sortPanesByPriority from app/client.ts (kept standalone so Bun tests
// do not require QuickJS / Solid JSX compiler transforms).
const STATUS_PRIORITY: Record<PaneActivityStatus, number> = {
  blocked: 0,
  error: 1,
  unseen_done: 2,
  running: 3,
  done: 4,
  idle: 5,
};

function sortPanesByPriority(panes: readonly PaneSummary[]): PaneSummary[] {
  return [...panes].sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? 5;
    const pb = STATUS_PRIORITY[b.status] ?? 5;
    if (pa !== pb) return pa - pb;
    return b.updatedAtMs - a.updatedAtMs;
  });
}

// Mirror of buildQrRuns from app/scenes/settings_pair.tsx.
interface QrRun {
  x: number;
  y: number;
  w: number;
  h: number;
}

function buildQrRuns(
  matrix: boolean[][] | null | undefined,
  boxSize: number,
): { runs: QrRun[]; ok: boolean; mod: number; offset: number } {
  if (!matrix || matrix.length === 0) return { runs: [], ok: false, mod: 0, offset: 0 };
  const n = matrix.length;
  const pad = 4;
  const usable = boxSize - pad * 2;
  const mod = Math.max(1, Math.min(3, Math.floor(usable / n)));
  const totalPx = n * mod;
  const off = Math.floor((boxSize - totalPx) / 2);
  const runs: QrRun[] = [];

  for (let r = 0; r < n; r++) {
    const row = matrix[r];
    if (!row) continue;
    let c = 0;
    while (c < row.length) {
      if (!row[c]) {
        c++;
        continue;
      }
      const start = c;
      while (c < row.length && row[c]) c++;
      runs.push({
        x: off + start * mod,
        y: off + r * mod,
        w: (c - start) * mod,
        h: mod,
      });
    }
  }
  return { runs, ok: runs.length > 0, mod, offset: off };
}

// Mirror of clampUtf8Bytes & UTF-8 codepoint-boundary chunker.
function clampUtf8Bytes(input: string, maxBytes: number): string {
  if (utf8(input).length <= maxBytes) return input;
  let out = "";
  let used = 0;
  for (const ch of input) {
    const n = utf8(ch).length;
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

function chunkUtf8Safe(input: string, maxBytes: number): string[] {
  if (maxBytes < 4) {
    throw new RangeError("maxBytes must be >= 4 to fit any single Unicode scalar");
  }
  if (input.length === 0) return [];
  const chunks: string[] = [];
  let cur = "";
  let used = 0;
  for (const ch of input) {
    const n = utf8(ch).length;
    if (cur.length > 0 && used + n > maxBytes) {
      chunks.push(cur);
      cur = ch;
      used = n;
    } else {
      cur += ch;
      used += n;
    }
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

function makePane(
  key: string,
  status: PaneActivityStatus,
  updatedAtMs: number,
): PaneSummary {
  return {
    key,
    hostId: "h1",
    hostLabel: "mini",
    sessionId: "s1",
    sessionLabel: "work",
    windowId: "w1",
    windowLabel: "main",
    blockId: key,
    title: key,
    program: "codex",
    pwd: "/tmp",
    status,
    ownedByUs: false,
    releasedByUs: false,
    hasDraft: false,
    updatedAtMs,
  };
}

describe("wire.ts UTF-8 codec", () => {
  test("round-trips ASCII, Latin, CJK, and astral emoji surrogates", () => {
    const samples = [
      "",
      "hello rex-zero 0.2.0",
      "café naïve résumé Ω≈ç√∫",
      "中文测试：龙门总控台已就绪，请审批写入操作。",
      "Mixed 中英 🚀🎉🧑‍💻 123 𐍈 end",
    ];
    for (const s of samples) {
      const encoded = utf8(s);
      expect(encoded).toEqual(new TextEncoder().encode(s));
      expect(text(encoded)).toBe(s);
    }
  });

  test("replaces lone UTF-16 surrogates with U+FFFD", () => {
    const withLoneHigh = "a\ud800b";
    const withLoneLow = "x\udfffy";
    expect(text(utf8(withLoneHigh))).toBe("a\ufffdb");
    expect(text(utf8(withLoneLow))).toBe("x\ufffdy");
  });

  test("replaces malformed UTF-8 byte sequences with U+FFFD", () => {
    // Truncated 3-byte CJK sequence (first 2 bytes of '中' = 0xe4 0xb8 0xad); wire.ts advances 1 byte per invalid lead/cont byte
    expect(text(new Uint8Array([0x41, 0xe4, 0xb8, 0x42]))).toBe("A\ufffd\ufffdB");
    expect(text(new Uint8Array([0x41, 0xc3]))).toBe("A\ufffd");
    // Unexpected continuation byte 0x80
    expect(text(new Uint8Array([0x80, 0x61]))).toBe("\ufffda");
    // Overlong 2-byte NUL (0xc0 0x80) and invalid lead byte 0xff
    expect(text(new Uint8Array([0xc0, 0x80, 0xff]))).toBe("\ufffd\ufffd\ufffd");
    // Overlong 3-byte (0xe0 0x80 0xaf) and UTF-16 surrogate in UTF-8 (0xed 0xa0 0x80)
    expect(text(new Uint8Array([0xe0, 0x80, 0xaf, 0xed, 0xa0, 0x80]))).toBe(
      "\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd",
    );
    // Above U+10FFFF (0xf4 0x90 0x80 0x80)
    expect(text(new Uint8Array([0xf4, 0x90, 0x80, 0x80, 0x7a]))).toBe("\ufffd\ufffd\ufffd\ufffdz");
  });
});

describe("wire.ts ring-channel framing", () => {
  test("encodeCall and decodeCall round-trip WireCall with CJK and emoji", () => {
    const call: WireCall = {
      url: "http://zero/rex/action",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "send_input", key: "local|s1|b1", data: "批准执行 🚀" }),
      timeoutMs: 12000,
      maxBytes: 65536,
    };
    const record = encodeCall(0x12345678, call);
    expect(record.byteLength).toBeLessThanOrEqual(RECORD_BYTES);
    const decoded = decodeCall(record);
    expect(decoded.id).toBe(0x12345678);
    expect(decoded.call).toEqual(call);

    // Non-zero byteOffset subarray view test
    const padded = new Uint8Array(record.length + 8);
    padded.set(record, 5);
    const subDecoded = decodeCall(padded.subarray(5, 5 + record.length));
    expect(subDecoded.id).toBe(0x12345678);
    expect(subDecoded.call).toEqual(call);
  });

  test("enforces exact 1020-byte request descriptor boundary", () => {
    const base: WireCall = {
      url: "http://zero/rex/action",
      method: "POST",
      body: "",
      timeoutMs: 8000,
      maxBytes: 4096,
    };
    const emptyBytes = utf8(JSON.stringify(base)).length;
    const maxFiller = RECORD_BYTES - 4 - emptyBytes;

    const atLimit: WireCall = { ...base, body: "a".repeat(maxFiller) };
    const encodedLimit = encodeCall(1, atLimit);
    expect(encodedLimit.length).toBe(RECORD_BYTES);
    expect(decodeCall(encodedLimit).call.body?.length).toBe(maxFiller);

    const overLimit: WireCall = { ...base, body: "a".repeat(maxFiller + 1) };
    expect(() => encodeCall(2, overLimit)).toThrow(RangeError);
  });

  test("answer() writes little-endian id, kind, and body payload", () => {
    const bodyBytes = utf8("中文响应体");
    const rec = answer(42, Answer.body, bodyBytes);
    expect(rec.length).toBe(HEADER_BYTES + bodyBytes.length);
    const view = new DataView(rec.buffer);
    expect(view.getUint32(0, true)).toBe(42);
    expect(view.getUint8(4)).toBe(Answer.body);
    expect(text(rec.subarray(HEADER_BYTES))).toBe("中文响应体");
  });
});

describe("Attention priority sorting", () => {
  test("sorts blocked > error > unseen_done > running > done > idle, then newest first", () => {
    const input = [
      makePane("idle-old", "idle", 100),
      makePane("done-new", "done", 500),
      makePane("running-1", "running", 200),
      makePane("unseen-old", "unseen_done", 300),
      makePane("unseen-new", "unseen_done", 900),
      makePane("error-1", "error", 400),
      makePane("blocked-old", "blocked", 50),
      makePane("blocked-new", "blocked", 800),
    ];

    const sorted = sortPanesByPriority(input);
    expect(sorted.map(p => p.key)).toEqual([
      "blocked-new",
      "blocked-old",
      "error-1",
      "unseen-new",
      "unseen-old",
      "running-1",
      "done-new",
      "idle-old",
    ]);
    // Input array is not mutated
    expect(input[0]?.key).toBe("idle-old");
  });
});

describe("QR horizontal run compression invariants", () => {
  test("handles null, empty, and all-light matrices gracefully", () => {
    expect(buildQrRuns(null, 116).ok).toBe(false);
    expect(buildQrRuns([], 116).ok).toBe(false);
    const allLight = Array.from({ length: 21 }, () => Array<boolean>(21).fill(false));
    expect(buildQrRuns(allLight, 116).ok).toBe(false);
  });

  test("covers exact dark pixels, merges horizontal runs, and stays within 116x116 box", () => {
    // Realistic 29x29 matrix with finder-like corner + checkerboard + full row
    const n = 29;
    const matrix: boolean[][] = Array.from({ length: n }, (_, r) =>
      Array.from({ length: n }, (_, c) => {
        if (r === 0 && c < 7) return true; // top finder bar
        if (r === 14) return true; // solid horizontal run
        if (r === 20) return c % 2 === 0; // alternating single modules
        return (r * 7 + c * 11) % 5 === 0;
      }),
    );

    const boxSize = 116;
    const { runs, ok, mod, offset } = buildQrRuns(matrix, boxSize);
    expect(ok).toBe(true);
    expect(mod).toBe(3); // floor((116 - 8) / 29) = 3

    // Reconstruct pixel grid from runs and verify exact 1:1 module coverage
    const grid = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
    for (const run of runs) {
      expect(run.x).toBeGreaterThanOrEqual(4);
      expect(run.y).toBeGreaterThanOrEqual(4);
      expect(run.x + run.w).toBeLessThanOrEqual(boxSize - 4);
      expect(run.y + run.h).toBeLessThanOrEqual(boxSize - 4);
      expect(run.h).toBe(mod);
      expect(run.w % mod).toBe(0);

      const r = (run.y - offset) / mod;
      const startC = (run.x - offset) / mod;
      const lenC = run.w / mod;
      for (let dc = 0; dc < lenC; dc++) {
        // Every dark module must be covered once and only once
        expect(grid[r]![startC + dc]).toBe(false);
        grid[r]![startC + dc] = true;
      }
    }
    expect(grid).toEqual(matrix);

    // Row 14 (solid dark) compresses into 1 run; Row 0 (bar of 7) starts with 1 merged run
    const row14Runs = runs.filter(r => (r.y - offset) / mod === 14);
    expect(row14Runs.length).toBe(1);
    expect(row14Runs[0]!.w).toBe(n * mod);
  });
});

describe("UTF-8 safe codepoint-boundary chunking", () => {
  test("clampUtf8Bytes never splits multi-byte CJK or emoji mid-scalar", () => {
    const s = "你好世界🚀测试"; // 4*3 + 4 + 2*3 = 22 bytes
    for (let limit = 0; limit <= 25; limit++) {
      const clamped = clampUtf8Bytes(s, limit);
      const bytes = utf8(clamped);
      expect(bytes.length).toBeLessThanOrEqual(limit);
      expect(s.startsWith(clamped)).toBe(true);
      expect(clamped.includes("\ufffd")).toBe(false);
      // Verify round-trip without replacement chars
      expect(text(bytes)).toBe(clamped);
    }
  });

  test("chunkUtf8Safe preserves every Unicode scalar across arbitrary byte limits", () => {
    const payload =
      "A中B文🎉C测D试🧑‍💻" +
      "请确认是否在 /Users/dev/work/rex-zero 执行 cargo zigbuild --release？" +
      "🚀✨🔥";
    for (const maxBytes of [4, 5, 7, 13, 64, RECORD_BYTES - HEADER_BYTES]) {
      const chunks = chunkUtf8Safe(payload, maxBytes);
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) {
        const b = utf8(c);
        expect(b.length).toBeGreaterThan(0);
        expect(b.length).toBeLessThanOrEqual(maxBytes);
        expect(text(b)).toBe(c);
        expect(c.includes("\ufffd")).toBe(false);
      }
      expect(chunks.join("")).toBe(payload);
    }
  });
});

describe("splitForWireCall double-escaping & 1020-byte framing", () => {
  const buildActionCall = (action: RexAction): WireCall => ({
    url: "http://zero/rex/action",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
    timeoutMs: 12000,
    maxBytes: 65536,
  });

  test("handles 400 backslashes with double JSON escaping and stageId under 1020 bytes", () => {
    const backslashes = "\\".repeat(400);
    const stageId = "s42";
    const chunks = splitForWireCall(backslashes, (chunk, idx, isLast) =>
      buildActionCall(
        isLast
          ? { op: "send_input", key: "mini|s1|b1", data: chunk, clearDraft: true, stageId }
          : { op: "send_input", key: "mini|s1|b1", data: chunk, stage: true, resetStage: idx === 0, stageId },
      ),
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(backslashes);

    chunks.forEach((chunk, idx) => {
      const isLast = idx === chunks.length - 1;
      const action: RexAction = isLast
        ? { op: "send_input", key: "mini|s1|b1", data: chunk, clearDraft: true, stageId }
        : { op: "send_input", key: "mini|s1|b1", data: chunk, stage: true, resetStage: idx === 0, stageId };
      const call = buildActionCall(action);
      expect(utf8(JSON.stringify(call)).length).toBeLessThanOrEqual(RECORD_BYTES - 4);
      const encoded = encodeCall(idx + 1, call);
      expect(encoded.byteLength).toBeLessThanOrEqual(RECORD_BYTES);
      const decoded = decodeCall(encoded);
      expect(JSON.parse(decoded.call.body!)).toEqual(action);
    });
  });

  test("splits CJK + emoji surrogate pairs + quotes/newlines losslessly under 1020 bytes", () => {
    const payload =
      '请审核以下脚本：\n"C:\\Users\\luna\\🚀测试\\🧑‍💻" -> ' +
      "中文长文本🎉🔥\"\\\n".repeat(70);
    const chunks = splitForWireCall(payload, (chunk, idx, isLast) =>
      buildActionCall(
        isLast
          ? { op: "send_input", key: "cp0|s0|b0", data: chunk, clearDraft: true }
          : { op: "send_input", key: "cp0|s0|b0", data: chunk, stage: true, resetStage: idx === 0 },
      ),
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(payload);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const chunk = chunks[i]!;
      expect(chunk.includes("\ufffd")).toBe(false);
      const call = buildActionCall(
        isLast
          ? { op: "send_input", key: "cp0|s0|b0", data: chunk, clearDraft: true }
          : { op: "send_input", key: "cp0|s0|b0", data: chunk, stage: true, resetStage: i === 0 },
      );
      expect(utf8(JSON.stringify(call)).length).toBeLessThanOrEqual(RECORD_BYTES - 4);
      const rec = encodeCall(100 + i, call);
      expect(rec.byteLength).toBeLessThanOrEqual(RECORD_BYTES);
      const parsed = JSON.parse(decodeCall(rec).call.body!) as { data: string };
      expect(parsed.data).toBe(chunk);
    }
  });

  test("splits >2000-byte drafts for save_draft with append flag and lossless round-trip", () => {
    const longDraft = "这是一段超过2000字节的中文草稿，包含引号\"与反斜杠\\以及🚀表情。".repeat(35);
    expect(utf8(longDraft).length).toBeGreaterThan(2000);

    const chunks = splitForWireCall(longDraft, (chunk, idx) =>
      buildActionCall(
        idx === 0
          ? { op: "save_draft", key: "moon|s2|b1", text: chunk }
          : { op: "save_draft", key: "moon|s2|b1", text: chunk, append: true },
      ),
    );

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    let rebuilt = "";
    chunks.forEach((chunk, idx) => {
      const action: RexAction =
        idx === 0
          ? { op: "save_draft", key: "moon|s2|b1", text: chunk }
          : { op: "save_draft", key: "moon|s2|b1", text: chunk, append: true };
      const call = buildActionCall(action);
      expect(utf8(JSON.stringify(call)).length).toBeLessThanOrEqual(RECORD_BYTES - 4);
      const rec = encodeCall(200 + idx, call);
      expect(rec.byteLength).toBeLessThanOrEqual(RECORD_BYTES);
      const decodedAction = JSON.parse(decodeCall(rec).call.body!) as { text: string; append?: boolean };
      if (idx === 0) expect(decodedAction.append).toBeUndefined();
      else expect(decodedAction.append).toBe(true);
      rebuilt += decodedAction.text;
    });
    expect(rebuilt).toBe(longDraft);
  });

  test("handles empty input as single empty chunk", () => {
    const chunks = splitForWireCall("", (chunk, idx) =>
      buildActionCall(idx === 0 ? { op: "save_draft", key: "k", text: chunk } : { op: "save_draft", key: "k", text: chunk, append: true }),
    );
    expect(chunks).toEqual([""]);
  });
});

describe("reconcileServerDraftUpdate multi-chunk echo & ASR merge invariants", () => {
  test("suppresses multi-chunk intermediate snapshot echoes without corrupting full local draft", () => {
    const chunk0 = "第一段长草稿内容_".repeat(50);
    const chunk1 = "第二段长草稿内容_".repeat(50);
    const chunk2 = "第三段长草稿内容_".repeat(20);
    const fullText = chunk0 + chunk1 + chunk2;

    // Chunk 0 was recorded before dispatch; snapshot arrives showing `chunk0` while chunks 1..2 are still pending.
    const pendingEchoes = new Set<string>([chunk0]);
    const res = reconcileServerDraftUpdate({
      oldSrv: "",
      newSrv: chunk0,
      entry: { text: fullText, baseServerText: "", dirty: true },
      lastAckedSave: chunk0,
      pendingEchoes,
    });

    expect(res.isEcho).toBe(true);
    expect(res.bumped).toBe(false);
    expect(res.needsSave).toBe(false);
    expect(res.nextEntry?.text).toBe(fullText);
    expect(res.nextEntry?.baseServerText).toBe(chunk0);
    expect(res.nextEntry?.dirty).toBe(true);

    // Even if snapshot arrived BEFORE chunk 0's HTTP ACK settled (only in `pendingEchoes`), it is still suppressed.
    const resPreAck = reconcileServerDraftUpdate({
      oldSrv: "",
      newSrv: chunk0,
      entry: { text: fullText, baseServerText: "", dirty: true },
      lastAckedSave: undefined,
      pendingEchoes,
    });
    expect(resPreAck.isEcho).toBe(true);
    expect(resPreAck.needsSave).toBe(false);
    expect(resPreAck.nextEntry?.text).toBe(fullText);
  });

  test("uses longest acknowledged prefix on skipped snapshot: A -> acked AB + local C -> server ABX => ABCX", () => {
    // Previous snapshot had "A"; autosave acknowledged "AB"; user typed "C" locally ("ABC");
    // next snapshot arrives directly with ASR dictation appended as "ABX" (skipping "AB").
    const res = reconcileServerDraftUpdate({
      oldSrv: "A",
      newSrv: "ABX",
      entry: { text: "ABC", baseServerText: "AB", dirty: true },
      lastAckedSave: "AB",
      pendingEchoes: new Set<string>(["AB"]),
    });

    expect(res.isEcho).toBe(false);
    expect(res.bumped).toBe(true);
    expect(res.needsSave).toBe(true);
    expect(res.nextEntry).toEqual({
      text: "ABCX",
      baseServerText: "ABX",
      dirty: true,
    });
  });

  test("adopts external ASR transcript cleanly when local entry is clean", () => {
    const res = reconcileServerDraftUpdate({
      oldSrv: "AB",
      newSrv: "AB语音输入",
      entry: { text: "AB", baseServerText: "AB", dirty: false },
      lastAckedSave: "AB",
      pendingEchoes: new Set<string>(["AB"]),
    });

    expect(res.isEcho).toBe(false);
    expect(res.bumped).toBe(true);
    expect(res.needsSave).toBe(false);
    expect(res.nextEntry).toEqual({
      text: "AB语音输入",
      baseServerText: "AB语音输入",
      dirty: false,
    });
  });

  test("(a) in-flight AB (pendingEchoes) + server ABX => ABX (no ABBX)", () => {
    const res = reconcileServerDraftUpdate({
      oldSrv: "A",
      newSrv: "ABX",
      entry: { text: "AB", baseServerText: "A", dirty: true },
      lastAckedSave: "A",
      pendingEchoes: new Set<string>(["AB"]),
    });

    expect(res.isEcho).toBe(false);
    expect(res.bumped).toBe(true);
    expect(res.needsSave).toBe(false);
    expect(res.nextEntry).toEqual({
      text: "ABX",
      baseServerText: "ABX",
      dirty: false,
    });
  });

  test("(b) unsaved local AX + ASR server AX (from A) => AXX", () => {
    const res = reconcileServerDraftUpdate({
      oldSrv: "A",
      newSrv: "AX",
      entry: { text: "AX", baseServerText: "A", dirty: true },
      lastAckedSave: "A",
      pendingEchoes: undefined,
    });

    expect(res.isEcho).toBe(false);
    expect(res.bumped).toBe(true);
    expect(res.needsSave).toBe(true);
    expect(res.nextEntry).toEqual({
      text: "AXX",
      baseServerText: "AX",
      dirty: true,
    });
  });
});

function makeSnapshot(revision: number, drafts: Record<string, string>): FleetSnapshot {
  return {
    revision,
    batteryPercent: 100,
    charging: false,
    hosts: [],
    panes: [],
    attention: {
      blockedCount: 0,
      errorCount: 0,
      unseenDoneCount: 0,
      nextTargetKey: null,
      chimeSeq: 0,
      chimeKind: "none",
      muted: false,
    },
    tailnet: {
      enabled: false,
      backendState: "Stopped",
      authUrl: "",
      qrMatrix: null,
      tailnetName: "",
      selfDns: "",
      proxyPort: 0,
      peers: [],
    },
    ime: {
      available: true,
      engine: "builtin",
      schema: "pinyin_simp",
    },
    asr: {
      configured: true,
      provider: "doubao",
      recording: false,
      busy: false,
      targetKey: null,
      partial: "",
      level: 0,
    },
    pair: {
      active: false,
      url: "",
      pin: "",
      expiresInSec: 0,
      qrMatrix: null,
    },
    drafts,
    mock: true,
  };
}

describe("createRexClient draft queue, pre-ACK ASR merge, and echo pruning", () => {
  test("(a) end-to-end: in-flight saveDraft('AB') + pre-reply ASR snapshot 'ABX' settles to 'ABX'", async () => {
    const key = "mini|s1|p1";
    let resolveSaveAB!: (reply: ActionReply) => void;
    let pushWait!: (snap: FleetSnapshot) => void;
    const savedTexts: string[] = [];

    const client = createRexClient(<T>(path: string, _method?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        return Promise.resolve(makeSnapshot(1, { [key]: "A" }) as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(resolve => {
          pushWait = snap => resolve(snap as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "save_draft") {
          savedTexts.push(act.text);
          if (act.text === "AB") {
            return new Promise<T>(resolve => {
              resolveSaveAB = reply => resolve(reply as unknown as T);
            });
          }
        }
        return Promise.resolve({ ok: true } as unknown as T);
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });

    client.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.getDraft(key)).toBe("A");

    // Dispatch saveDraft("AB"), keeping its HTTP reply pending while ASR snapshot "ABX" arrives first.
    const savePromise = client.saveDraft(key, "AB");
    await Promise.resolve();
    expect(savedTexts).toEqual(["AB"]);

    pushWait(makeSnapshot(2, { [key]: "ABX" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(client.getDraft(key)).toBe("ABX");
    expect(client.getLastQueuedSaveTarget(key)).toBe("ABX");

    resolveSaveAB({ ok: true });
    await savePromise;
    expect(client.getDraft(key)).toBe("ABX");
    // Must NOT persist duplicated "ABBX".
    expect(savedTexts).toEqual(["AB"]);
  });

  test("(b) end-to-end: unsaved local 'AX' + ASR snapshot 'AX' (from 'A') merges and persists 'AXX'", async () => {
    const key = "mini|s1|p2";
    let pushWait!: (snap: FleetSnapshot) => void;
    const savedTexts: string[] = [];

    const client = createRexClient(<T>(path: string, _method?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        return Promise.resolve(makeSnapshot(1, { [key]: "A" }) as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(resolve => {
          pushWait = snap => resolve(snap as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "save_draft") {
          savedTexts.push(act.text);
        }
        return Promise.resolve({ ok: true } as unknown as T);
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });

    client.start();
    await Promise.resolve();
    await Promise.resolve();

    // User types "X" locally (unsaved) while ASR dictates "X" onto "A" on the server.
    client.setLocalDraft(key, "AX", { dirty: true });
    pushWait(makeSnapshot(2, { [key]: "AX" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(client.getDraft(key)).toBe("AXX");
    expect(savedTexts).toEqual(["AXX"]);
  });

  test("(c) saveDraft('AB') in flight followed by saveDraft('A') leaves final state 'A' and prunes stale 'AB' echo", async () => {
    const key = "mini|s1|p3";
    let hostDraft = "A";
    let resolveSaveAB!: (reply: ActionReply) => void;
    let pushWait!: (snap: FleetSnapshot) => void;
    const hostWriteOrder: string[] = [];

    const client = createRexClient(<T>(path: string, _method?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        return Promise.resolve(makeSnapshot(1, { [key]: "A" }) as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(resolve => {
          pushWait = snap => resolve(snap as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "save_draft") {
          hostWriteOrder.push(act.text);
          hostDraft = act.append ? hostDraft + act.text : act.text;
          if (act.text === "AB") {
            return new Promise<T>(resolve => {
              resolveSaveAB = reply => resolve(reply as unknown as T);
            });
          }
        }
        return Promise.resolve({ ok: true } as unknown as T);
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });

    client.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.getLastQueuedSaveTarget(key)).toBe("A");

    // 1. Typing "B" starts saveDraft("AB") -> lastQueuedSaveTarget immediately becomes "AB",
    //    and one microtask tick dispatches the "AB" request onto the wire (in-flight).
    const saveAB = client.saveDraft(key, "AB");
    expect(client.getLastQueuedSaveTarget(key)).toBe("AB");
    await Promise.resolve();
    expect(hostWriteOrder).toEqual(["AB"]);

    // 2. User backspaces back to "A" and flushes before "AB" reply arrives:
    //    because "A" !== getLastQueuedSaveTarget(key) ("AB"), saveDraft("A") MUST be queued!
    client.setLocalDraft(key, "A", { dirty: true });
    expect("A" !== client.getLastQueuedSaveTarget(key)).toBe(true);
    const saveA = client.saveDraft(key, "A");
    expect(client.getLastQueuedSaveTarget(key)).toBe("A");

    // 3. Let in-flight "AB" finish; queued "A" runs immediately behind it on draftOpChain.
    resolveSaveAB({ ok: true });
    await Promise.all([saveAB, saveA]);

    expect(hostWriteOrder).toEqual(["AB", "A"]);
    expect(hostDraft).toBe("A");
    expect(client.getDraft(key)).toBe("A");
    expect(client.getLastQueuedSaveTarget(key)).toBe("A");

    // 4. Subsequent ASR transition to "AB" must NOT be suppressed by the superseded "AB" echo.
    pushWait(makeSnapshot(2, { [key]: "AB" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(client.getDraft(key)).toBe("AB");
  });

  test("(d) sendInput(clearDraft=true) preserves ASR transcript arriving before send reply", async () => {
    const key = "mini|s1|p4";
    let resolveSend!: (reply: ActionReply) => void;
    let pushWait!: (snap: FleetSnapshot) => void;

    const client = createRexClient(<T>(path: string, _method?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        return Promise.resolve(makeSnapshot(1, { [key]: "old draft" }) as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(resolve => {
          pushWait = snap => resolve(snap as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "send_input") {
          return new Promise<T>(resolve => {
            resolveSend = reply => resolve(reply as unknown as T);
          });
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });

    client.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.getDraft(key)).toBe("old draft");

    // Start sendInput with clearDraft=true while ASR dictates new text before HTTP reply settles.
    const sendPromise = client.sendInput(key, "old draft\r", true);
    await Promise.resolve();

    pushWait(makeSnapshot(2, { [key]: "ASR新转录" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(client.getDraft(key)).toBe("ASR新转录");

    resolveSend({ ok: true });
    await sendPromise;

    // Must preserve reconciled ASR draft instead of clobbering it to "".
    expect(client.getDraft(key)).toBe("ASR新转录");
    expect(client.getLastQueuedSaveTarget(key)).toBe("ASR新转录");
  });

  test("(e) multi-chunk saveDraft aborts remaining chunks when ASR lands during chunk 0 and converges without AXB duplication", async () => {
    const key = "mini|s1|p5";
    const fullText = "A".repeat(700) + "B".repeat(700);
    const asrText = "语音追加X";
    let hostDraft = "";
    let resolveFirstChunk!: (reply: ActionReply) => void;
    let firstChunkSent = false;
    let pushWait!: (snap: FleetSnapshot) => void;
    const wireActions: Array<{ text: string; append?: boolean }> = [];
    const observedHostStates: string[] = [];

    const client = createRexClient(<T>(path: string, _method?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        return Promise.resolve(makeSnapshot(1, { [key]: "" }) as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(resolve => {
          pushWait = snap => resolve(snap as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "save_draft") {
          wireActions.push({ text: act.text, append: act.append });
          hostDraft = act.append ? hostDraft + act.text : act.text;
          observedHostStates.push(hostDraft);
          if (!firstChunkSent) {
            firstChunkSent = true;
            return new Promise<T>(resolve => {
              resolveFirstChunk = reply => resolve(reply as unknown as T);
            });
          }
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });

    client.start();
    await Promise.resolve();
    await Promise.resolve();

    const savePromise = client.saveDraft(key, fullText);
    await Promise.resolve();
    expect(wireActions.length).toBe(1);
    expect(wireActions[0]!.append).toBeUndefined();
    const chunk0 = wireActions[0]!.text;
    expect(chunk0.length).toBeLessThan(fullText.length);

    // ASR writes onto server while chunk 0 reply is still in flight.
    hostDraft = chunk0 + asrText;
    pushWait(makeSnapshot(2, { [key]: hostDraft }));
    await Promise.resolve();
    await Promise.resolve();
    expect(client.getDraft(key)).toBe(fullText + asrText);

    // Chunk 0 settles: remaining append chunk of original `fullText` must be aborted,
    // and the follow-up full save must rewrite `fullText + asrText` cleanly.
    resolveFirstChunk({ ok: true });
    await savePromise;
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // Action #1 (index 1) must be a fresh chunk 0 (append === undefined), NOT an append onto `chunk0 + asrText`.
    expect(wireActions.length).toBeGreaterThanOrEqual(3);
    expect(wireActions[1]!.append).toBeUndefined();
    expect(observedHostStates.some(s => s.includes(asrText) && s.endsWith("B".repeat(50)))).toBe(false);
    expect(hostDraft).toBe(fullText + asrText);
    expect(client.getDraft(key)).toBe(fullText + asrText);
  });

  test("(f) multi-chunk saveDraft suppresses AXB echo when ASR lands before final append chunk", async () => {
    const key = "mini|s1|p6";
    const fullText = "A".repeat(700) + "B".repeat(500);
    const asrText = "语音插队";
    let hostDraft = "";
    let saveCallCount = 0;
    let resolveChunk1!: (reply: ActionReply) => void;
    let resolveFollowup0!: (reply: ActionReply) => void;
    let pushWait!: (snap: FleetSnapshot) => void;

    const client = createRexClient(<T>(path: string, _method?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        return Promise.resolve(makeSnapshot(1, { [key]: "" }) as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(resolve => {
          pushWait = snap => resolve(snap as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "save_draft") {
          saveCallCount++;
          if (saveCallCount === 1) {
            hostDraft = act.text;
            return Promise.resolve({ ok: true } as unknown as T);
          }
          if (saveCallCount === 2) {
            // Simulate ASR landing on host right before append chunk 1.
            hostDraft = hostDraft + asrText;
            const asrSnapshot = hostDraft;
            hostDraft = hostDraft + act.text;
            return new Promise<T>(resolve => {
              // Deliver ASR snapshot first, then allow test to settle chunk 1 reply.
              pushWait(makeSnapshot(2, { [key]: asrSnapshot }));
              resolveChunk1 = reply => resolve(reply as unknown as T);
            });
          }
          if (saveCallCount === 3) {
            hostDraft = act.text;
            return new Promise<T>(resolve => {
              resolveFollowup0 = reply => resolve(reply as unknown as T);
            });
          }
          hostDraft = act.append ? hostDraft + act.text : act.text;
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });

    client.start();
    await Promise.resolve();
    await Promise.resolve();

    const savePromise = client.saveDraft(key, fullText);
    for (let i = 0; i < 6; i++) await Promise.resolve();

    const axbHostDraft = hostDraft;
    expect(axbHostDraft.includes(asrText)).toBe(true);
    expect(client.getDraft(key)).toBe(fullText + asrText);

    // Settle chunk 1 reply; follow-up save chunk 0 begins.
    resolveChunk1({ ok: true });
    await savePromise;
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Delayed AXB snapshot arrives while follow-up save is in flight: must be suppressed as echo (no B duplication).
    pushWait(makeSnapshot(3, { [key]: axbHostDraft }));
    await Promise.resolve();
    await Promise.resolve();
    expect(client.getDraft(key)).toBe(fullText + asrText);

    resolveFollowup0({ ok: true });
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(hostDraft).toBe(fullText + asrText);
    expect(client.getDraft(key)).toBe(fullText + asrText);
  });

  test("(g) conditional ifDraftVer append rejects stale B on concurrent ASR (including XBY containing B) without duplication or data loss", async () => {
    const key = "mini|s1|p7";
    const fullText = "P".repeat(700) + "B".repeat(500);
    // Deliberately include a literal tail substring in ASR to ensure we never strip dictated characters!
    const asrText = "语音X" + "B".repeat(379) + "尾Y";

    let hostDraft = "";
    let hostVer = 0;
    let hostRev = 1;
    let saveCallCount = 0;
    let resolveConflictC1!: (r: ActionReply) => void;
    const waitQueue: FleetSnapshot[] = [];
    let currentWaitResolve: ((s: FleetSnapshot) => void) | null = null;
    function enqueueWait(snap: FleetSnapshot): void {
      if (currentWaitResolve) {
        const r = currentWaitResolve;
        currentWaitResolve = null;
        r(snap);
      } else {
        waitQueue.push(snap);
      }
    }

    const client = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        return Promise.resolve(makeSnapshot(hostRev, { [key]: "" }) as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        if (waitQueue.length > 0) return Promise.resolve(waitQueue.shift()! as unknown as T);
        return new Promise<T>(r => {
          currentWaitResolve = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "save_draft") {
          saveCallCount++;
          if (saveCallCount === 1) {
            expect(act.append).toBeUndefined();
            hostDraft = act.text;
            hostVer++;
            hostRev++;
            return Promise.resolve({ ok: true, draftVer: hostVer, revision: hostRev } as unknown as T);
          }
          if (saveCallCount === 2) {
            expect(act.append).toBe(true);
            expect(act.ifDraftVer).toBe(1);
            // Concurrent ASR lands on host BEFORE append chunk 1 is processed!
            hostDraft = hostDraft + asrText;
            hostVer++;
            hostRev++;
            const conflictReply: ActionReply = {
              ok: true,
              conflict: true,
              draftVer: hostVer,
              revision: hostRev,
              serverDraft: hostDraft,
            };
            // Also queue `/rex/wait` snapshot to arrive AFTER conflict reply (testing inline serverDraft reconciliation too).
            return new Promise<T>(r => {
              resolveConflictC1 = rep => r(rep as unknown as T);
              void Promise.resolve().then(() => resolveConflictC1(conflictReply));
            });
          }
          // Follow-up clean full re-save after conflict reconciliation:
          if (act.append && act.ifDraftVer !== undefined && act.ifDraftVer !== hostVer) {
            return Promise.resolve({
              ok: true,
              conflict: true,
              draftVer: hostVer,
              revision: hostRev,
              serverDraft: hostDraft,
            } as unknown as T);
          }
          hostDraft = act.append ? hostDraft + act.text : act.text;
          hostVer++;
          hostRev++;
          return Promise.resolve({ ok: true, draftVer: hostVer, revision: hostRev } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });

    client.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const savePromise = client.saveDraft(key, fullText);
    await savePromise;
    for (let i = 0; i < 16; i++) await Promise.resolve();

    // Delayed `/rex/wait` snapshot of the earlier ASR state arrives late -> clean no-op, no re-merge.
    enqueueWait(makeSnapshot(3, { [key]: hostDraft }));
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(hostDraft).toBe(fullText + asrText);
    expect(client.getDraft(key)).toBe(fullText + asrText);
  });

  test("(h) pre-ACK exact PB snapshot followed by PBX snapshot preserves confirmed append B", async () => {
    const key = "mini|s1|p8";
    const fullText = "P".repeat(700) + "B".repeat(500);
    let chunk0 = "";
    let chunk1 = "";
    let resolveC1!: (r: ActionReply) => void;
    let saveCallCount = 0;
    let pushWait!: (snap: FleetSnapshot) => void;

    const client = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") return Promise.resolve(makeSnapshot(1, { [key]: "" }) as unknown as T);
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "save_draft") {
          saveCallCount++;
          if (saveCallCount === 1) {
            chunk0 = act.text;
            return Promise.resolve({ ok: true, draftVer: 1, revision: 2 } as unknown as T);
          }
          if (saveCallCount === 2) {
            chunk1 = act.text;
            return new Promise<T>(r => {
              resolveC1 = rep => r(rep as unknown as T);
            });
          }
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });

    client.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const savePromise = client.saveDraft(key, fullText);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(chunk0 + chunk1).toBe(fullText);

    // 1. Exact PB snapshot arrives before C1 HTTP reply settles -> marks entry clean at PB.
    pushWait(makeSnapshot(3, { [key]: fullText }));
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(client.getDraft(key)).toBe(fullText);

    // 2. Subsequent PBX snapshot arrives while C1 HTTP reply is STILL pending -> must adopt PBX (never strip B!).
    pushWait(makeSnapshot(4, { [key]: fullText + "语音X" }));
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(client.getDraft(key)).toBe(fullText + "语音X");

    resolveC1({ ok: true, draftVer: 2, revision: 3 });
    await savePromise;
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(client.getDraft(key)).toBe(fullText + "语音X");
    expect(saveCallCount).toBe(2);
  });

  test("(i) locked send with queued IME + pre-send ASR recovers ONLY X on success, survives delayed clear snapshot, and expires clear echo", async () => {
    const key = "mini|s1|p9";
    let pushWait!: (snap: FleetSnapshot) => void;
    const savedTexts: string[] = [];

    const client = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") return Promise.resolve(makeSnapshot(1, { [key]: "A" }) as unknown as T);
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "send_input") {
          return Promise.resolve({ ok: true, revision: 3, draftCleared: true } as unknown as T);
        }
        if (act.op === "save_draft") {
          savedTexts.push(act.text);
          return Promise.resolve({ ok: true, revision: 4, draftVer: 2 } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });

    client.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(client.getDraft(key)).toBe("A");

    // 1. User presses Enter locking draft "A" while IME commit "B" is in flight on imeChain.
    expect(client.beginPendingSend(key, "A")).toBe(true);

    // 2. BEFORE `sendInput` even starts (during imeChain), ASR snapshot "AX" arrives!
    pushWait(makeSnapshot(2, { [key]: "AX" }));
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // 3. IME commit "B" finishes onto pendingSend -> "AB". If send were to fail now, restore must be "ABX".
    client.updatePendingSend(key, prev => prev + "B");
    expect(client.getFailedSendRestore(key)).toBe("ABX");

    // 4. Send succeeds delivering "AB\r"; recovery save runs and settles BEFORE delayed clear snapshot "" arrives!
    const sendRes = await client.sendInput(key, "AB\r", true);
    expect(sendRes.ok).toBe(true);
    client.endPendingSend(key);
    for (let i = 0; i < 8; i++) await Promise.resolve();

    // Recovery must persist ONLY "X" (never "AX" or "ABX")!
    expect(savedTexts).toEqual(["X"]);
    expect(client.getDraft(key)).toBe("X");

    // 5. Delayed empty clear snapshot (rev 3) arrives AFTER recovery save settled -> suppressed, "X" survives!
    pushWait(makeSnapshot(3, {}));
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(client.getDraft(key)).toBe("X");

    // 6. Recovery save snapshot (rev 4, "X") arrives -> marks "X" clean and leaves zero lingering clear echoes.
    pushWait(makeSnapshot(4, { [key]: "X" }));
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(client.getDraft(key)).toBe("X");

    // 7. Subsequent genuine external clear (rev 5, "") MUST NOT be suppressed as a stale echo!
    pushWait(makeSnapshot(5, {}));
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(client.getDraft(key)).toBe("");
  });

  test("(j) send lock anchors ifDraftVer, discards older serverDraft replies, and version-checks recovery write against subsequent ASR", async () => {
    const key = "mini|s1|p10";
    let pushWait!: (snap: FleetSnapshot) => void;
    const seenActions: RexAction[] = [];

    const client = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(1, { [key]: "A" });
        snap.draftMeta = { [key]: { ver: 5, clientSeq: 1 } };
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        seenActions.push(act);
        if (act.op === "send_input") {
          // Send MUST carry the version locked at beginPendingSend (`5`), even if ASR arrived before send_input!
          expect(act.ifDraftVer).toBe(5);
          // Simulate older serverDraft ("A X", ver 6) arriving AFTER newer snapshot ("A X Y", ver 7) was already applied!
          return Promise.resolve({
            ok: true,
            revision: 2,
            draftCleared: false,
            draftVer: 6,
            clientSeq: 1,
            serverDraft: "A X",
          } as unknown as T);
        }
        if (act.op === "save_draft") {
          if (seenActions.filter(a => a.op === "save_draft").length === 1) {
            // First recovery save carries `ifDraftVer: 7`; simulate ASR " Z" landing (ver 8) right before it commits!
            expect(act.text).toBe(" X Y");
            expect(act.ifDraftVer).toBe(7);
            return Promise.resolve({
              ok: true,
              revision: 4,
              conflict: true,
              draftVer: 8,
              clientSeq: 1,
              serverDraft: "A X Y Z",
            } as unknown as T);
          }
          // Retried recovery save incorporates " Z" and commits cleanly with `ifDraftVer: 8`!
          expect(act.text).toBe(" X Y Z");
          expect(act.ifDraftVer).toBe(8);
          return Promise.resolve({
            ok: true,
            revision: 5,
            draftVer: 9,
            clientSeq: act.clientSeq,
          } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });

    client.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Lock send at ver=5 ("A"); snapshot jumps straight to ver=7 ("A X Y") before sendInput reply (ver=6) settles!
    expect(client.beginPendingSend(key, "A")).toBe(true);
    const snap7 = makeSnapshot(3, { [key]: "A X Y" });
    snap7.draftMeta = { [key]: { ver: 7, clientSeq: 1 } };
    pushWait(snap7);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const r = await client.sendInput(key, "A\r", true);
    expect(r.ok).toBe(true);
    client.endPendingSend(key);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    // Older reply (ver=6, "A X") must NOT roll backward " Y", and conflicting recovery write merges " Z"!
    expect(client.getDraft(key)).toBe(" X Y Z");
  });

  test("(k) clientSeq attribution preserves full ASR ' XY' when un-committed append chunk is ' X', and external clear supersedes interrupted save", async () => {
    const key = "mini|s1|p11";
    const pText = "P".repeat(900);
    const fullText = pText + " X";
    let chunk0Text = "";
    let chunk1Text = "";
    let seenClientId = "";
    let pushWait!: (snap: FleetSnapshot) => void;
    let resolveC1!: (r: ActionReply) => void;
    let saveCalls = 0;

    const client = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(1, {});
        snap.draftMeta = {};
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "save_draft") {
          saveCalls++;
          if (saveCalls === 1) {
            chunk0Text = act.text;
            seenClientId = act.clientId ?? "";
            return Promise.resolve({
              ok: true,
              revision: 2,
              draftVer: 10,
              clientId: act.clientId,
              clientSeq: act.clientSeq,
            } as unknown as T);
          }
          if (saveCalls === 2) {
            chunk1Text = act.text;
            return new Promise<T>(r => {
              resolveC1 = rep => r(rep as unknown as T);
            });
          }
          return Promise.resolve({
            ok: true,
            revision: 6,
            draftVer: 13,
            clientId: act.clientId,
            clientSeq: act.clientSeq,
          } as unknown as T);
        }
        if (act.op === "send_input") {
          return Promise.resolve({
            ok: true,
            revision: 5,
            draftCleared: false,
            draftVer: 11,
            clientId: seenClientId,
            clientSeq: 1,
            serverDraft: chunk0Text + chunk1Text + "Y",
          } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });

    client.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Start multi-chunk save of `fullText`; chunk 0 (`chunk0Text`, clientSeq=1) commits,
    // chunk 1 (`chunk1Text`, clientSeq=2) is in flight while ASR independently appends `chunk1Text + "Y"`.
    const savePromise = client.saveDraft(key, fullText);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(saveCalls).toBe(2);
    expect(chunk1Text.endsWith(" X")).toBe(true);

    // User locks send on `fullText` while chunk 1 is still in flight.
    expect(client.beginPendingSend(key, fullText)).toBe(true);

    // Pre-reply snapshot arrives with `chunk0Text + chunk1Text + "Y"` and `clientSeq: 1`
    // (proving chunk 1 did NOT commit — ASR itself dictated `chunk1Text + "Y"`!).
    const asrDictated = chunk1Text + "Y";
    const snapAsr = makeSnapshot(3, { [key]: chunk0Text + asrDictated });
    snapAsr.draftMeta = { [key]: { ver: 11, clientId: seenClientId, clientSeq: 1 } };
    pushWait(snapAsr);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Settle chunk 1 as conflict; then settle sendInput -> must recover ALL of `asrDictated` (not just `"Y"`)!
    resolveC1({
      ok: true,
      revision: 3,
      conflict: true,
      draftVer: 11,
      clientId: seenClientId,
      clientSeq: 1,
      serverDraft: chunk0Text + asrDictated,
    });
    await savePromise;
    const sendRes = await client.sendInput(key, `${fullText}\r`, true);
    expect(sendRes.ok).toBe(true);
    client.endPendingSend(key);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(client.getDraft(key)).toBe(asrDictated);

    // Now test concurrent external clear during another multi-chunk save (with post-save edit "+TAIL"):
    const key2 = "mini|s1|p12";
    let resolveK2C1!: (r: ActionReply) => void;
    let k2Calls = 0;
    const client2 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(1, {});
        snap.draftMeta = {};
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) return new Promise<T>(() => {});
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "save_draft") {
          k2Calls++;
          if (k2Calls === 1) {
            return Promise.resolve({ ok: true, revision: 2, draftVer: 1, clientSeq: act.clientSeq } as unknown as T);
          }
          if (k2Calls === 2) {
            return new Promise<T>(r => {
              resolveK2C1 = rep => r(rep as unknown as T);
            });
          }
          expect(act.text).toBe("+TAIL");
          return Promise.resolve({ ok: true, revision: 4, draftVer: 3, clientSeq: act.clientSeq } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });
    client2.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const p2 = client2.saveDraft(key2, fullText);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    // User types "+TAIL" locally after initiating `saveDraft(key2, fullText)` while another client clears the host draft:
    client2.setLocalDraft(key2, fullText + "+TAIL", { dirty: true });
    resolveK2C1({
      ok: true,
      revision: 3,
      conflict: true,
      draftVer: 2,
      clientSeq: 1,
      serverDraft: "",
    });
    await p2;
    for (let i = 0; i < 8; i++) await Promise.resolve();
    // Interrupted `fullText` was superseded by external clear; ONLY post-save "+TAIL" survives!
    expect(client2.getDraft(key2)).toBe("+TAIL");
  });

  test("(l) clientId scoping across restarts, post-clear 'A B' sharing prefix 'A', durability error commit tracking, and conflict-retry error propagation", async () => {
    // 1. Cross-restart `clientId` isolation + post-clear `"A B"` sharing submitted prefix `"A"`:
    const key = "mini|s1|p13";
    let pushWait!: (snap: FleetSnapshot) => void;
    let resolveSave1!: (r: ActionReply) => void;
    let resolveSend!: (r: ActionReply) => void;
    let seenSendClientId = "";
    let seenSendSeq = 0;

    const client = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        // Server still holds `clientSeq: 40` from a PREVIOUS UI session (`clientId: "old-session"`).
        const snap = makeSnapshot(1, { [key]: "A" });
        snap.draftMeta = { [key]: { ver: 10, clientId: "old-session", clientSeq: 40 } };
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "save_draft" && !resolveSave1) {
          return new Promise<T>(r => {
            resolveSave1 = rep => r(rep as unknown as T);
          });
        }
        if (act.op === "send_input" && act.clearDraft) {
          seenSendClientId = act.clientId ?? "";
          seenSendSeq = act.clientSeq ?? 0;
          return new Promise<T>(r => {
            resolveSend = rep => r(rep as unknown as T);
          });
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });

    client.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // New UI starts `saveDraft(key, "A X")` at `seq=1`; ASR changes `"A"` -> `"A XY"` while server still reports `"old-session"` seq=40!
    const pSave = client.saveDraft(key, "A X");
    await Promise.resolve();
    const snapOldCid = makeSnapshot(2, { [key]: "A XY" });
    snapOldCid.draftMeta = { [key]: { ver: 11, clientId: "old-session", clientSeq: 40 } };
    pushWait(snapOldCid);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    // Must NOT credit new UI's uncommitted `"A X"` against `"old-session"` seq=40: merged draft must be `"A X XY"`!
    expect(client.getDraft(key)).toBe("A X XY");
    resolveSave1({
      ok: true,
      revision: 2,
      conflict: true,
      draftVer: 11,
      clientId: "old-session",
      clientSeq: 40,
      serverDraft: "A XY",
    });
    await pSave;
    for (let i = 0; i < 8; i++) await Promise.resolve();

    // Now test post-clear ASR `"A XY B"` sharing prefix with pre-send `"A XY"` when snapshot skips `""`:
    const snapReady = makeSnapshot(4, { [key]: "A" });
    snapReady.draftMeta = { [key]: { ver: 20, clientId: "ext", clientSeq: 1 } };
    pushWait(snapReady);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    client.setLocalDraft(key, "A", { dirty: false, baseServerText: "A" });

    expect(client.beginPendingSend(key, "A")).toBe(true);
    const pSend = client.sendInput(key, "A\r", true);
    await Promise.resolve();
    expect(seenSendSeq).toBeGreaterThan(0);

    // Server clears `"A"` at ver=21 (`clientId: seenSendClientId, clientSeq: seenSendSeq`), then ASR writes `"A B"` at ver=22;
    // snapshot skips `""` and delivers `"A B"` BEFORE `pSend` settles!
    const snapPostClear = makeSnapshot(6, { [key]: "A B" });
    snapPostClear.draftMeta = { [key]: { ver: 22, clientId: seenSendClientId, clientSeq: seenSendSeq } };
    pushWait(snapPostClear);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    resolveSend({
      ok: true,
      revision: 5,
      draftCleared: true,
      draftVer: 21,
      clientId: seenSendClientId,
      clientSeq: seenSendSeq,
    });
    await pSend;
    client.endPendingSend(key);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    // Full `"A B"` must survive (never stripped to `" B"` against pre-clear `"A"`)!
    expect(client.getDraft(key)).toBe("A B");

    // 2. Durability failure (`ok: false` with committed `draftVer`) + conflict recovery error propagation + explicit `dispatchAction` forwarding:
    const key2 = "mini|s1|p14";
    let pushWait2!: (snap: FleetSnapshot) => void;
    const rawForwarded: RexAction[] = [];
    let attempt = 0;
    const client2 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(1, {});
        snap.draftMeta = {};
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait2 = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        rawForwarded.push(act);
        if (act.op === "save_draft" && act.key === key2) {
          attempt++;
          if (attempt === 1) {
            // Conflict triggers retry
            return Promise.resolve({
              ok: true,
              revision: 2,
              conflict: true,
              draftVer: 1,
              serverDraft: "ASR",
            } as unknown as T);
          }
          // Retry commits in memory (draftVer: 2) but fails disk persistence!
          return Promise.resolve({
            ok: false,
            error: "保存草稿失败: ENOSPC",
            revision: 3,
            draftVer: 2,
            clientId: act.clientId,
            clientSeq: act.clientSeq,
          } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });
    client2.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Caller of `saveDraft` receives the retry's failure (`ok: false`) instead of the initial conflict's `ok: true`!
    const retryRes = await client2.saveDraft(key2, "LOCAL");
    expect(retryRes.ok).toBe(false);
    expect(retryRes.error).toContain("ENOSPC");

    // Subsequent snapshot carrying the in-memory committed `"LOCALASR"` (ver=2) is recognized as already committed (no duplication)!
    const snapInMem = makeSnapshot(3, { [key2]: "LOCALASR" });
    snapInMem.draftMeta = { [key2]: { ver: 2 } };
    pushWait2(snapInMem);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(client2.getDraft(key2)).toBe("LOCALASR");

    // Explicit `ifDraftVer` and `stageId` on `dispatchAction` are forwarded untouched!
    await client2.dispatchAction({ op: "save_draft", key: "raw|s|b", text: "x", ifDraftVer: 4 });
    await client2.dispatchAction({ op: "send_input", key: "raw|s|b", data: "z", stageId: "custom-s9", ifDraftVer: 4 });
    expect(rawForwarded[rawForwarded.length - 2]).toEqual({
      op: "save_draft",
      key: "raw|s|b",
      text: "x",
      ifDraftVer: 4,
    });
    expect(rawForwarded[rawForwarded.length - 1]).toEqual({
      op: "send_input",
      key: "raw|s|b",
      data: "z",
      stageId: "custom-s9",
      ifDraftVer: 4,
    });
  });

  test("(m) multi-snapshot clearSeq idempotency, foreign post-clear 'A B', versioned acked echoes, pre-reply chunk0 latch, and clear persistError retry", async () => {
    // 1. Two pre-reply ASR snapshots ("B", then "B C") carrying the SAME committed clearSeq must NOT duplicate "B" into "BB C":
    const key1 = "mini|s1|p15";
    let pushWait1!: (snap: FleetSnapshot) => void;
    let resolveSend1!: (reply: ActionReply) => void;
    let sendCid1: string | undefined;
    let sendSeq1: number | undefined;

    const client1 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(1, { [key1]: "A" });
        snap.draftMeta = { [key1]: { ver: 10, clientId: "seed", clientSeq: 1 } };
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait1 = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "send_input" && act.key === key1) {
          sendCid1 = act.clientId;
          sendSeq1 = act.clientSeq;
          return new Promise<T>(r => {
            resolveSend1 = rep => r(rep as unknown as T);
          });
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });
    client1.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(client1.beginPendingSend(key1, "A")).toBe(true);
    const pSend1 = client1.sendInput(key1, "A\r", true);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Snapshot 1: server cleared "A" (ver 11) and ASR appended "B" (ver 12), still carrying `(sendCid1, sendSeq1)`.
    const s1 = makeSnapshot(2, { [key1]: "B" });
    s1.draftMeta = { [key1]: { ver: 12, clientId: sendCid1, clientSeq: sendSeq1! } };
    pushWait1(s1);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Snapshot 2 (still before sendInput HTTP reply!): ASR appended " C" -> "B C" (ver 13), SAME `(sendCid1, sendSeq1)`.
    const s2 = makeSnapshot(3, { [key1]: "B C" });
    s2.draftMeta = { [key1]: { ver: 13, clientId: sendCid1, clientSeq: sendSeq1! } };
    pushWait1(s2);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    resolveSend1({
      ok: true,
      revision: 1,
      draftCleared: true,
      draftVer: 11,
      clientId: sendCid1,
      clientSeq: sendSeq1,
    });
    await pSend1;
    client1.endPendingSend(key1);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(client1.getDraft(key1)).toBe("B C");

    // 2. Foreign replacement `"A B"` (`clientId: "other"`, `ver: 22`) arriving before own clear reply (`draftVer: 21`):
    const key2 = "mini|s1|p16";
    let pushWait2!: (snap: FleetSnapshot) => void;
    let resolveSend2!: (reply: ActionReply) => void;
    const savedOnKey2: string[] = [];

    const client2 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(1, { [key2]: "A" });
        snap.draftMeta = { [key2]: { ver: 20, clientId: "seed", clientSeq: 1 } };
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait2 = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "send_input" && act.key === key2) {
          return new Promise<T>(r => {
            resolveSend2 = rep => r(rep as unknown as T);
          });
        }
        if (act.op === "save_draft" && act.key === key2) {
          savedOnKey2.push(act.text);
          return Promise.resolve({ ok: true, revision: 10, draftVer: 23 } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });
    client2.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(client2.beginPendingSend(key2, "A")).toBe(true);
    const pSend2 = client2.sendInput(key2, "A\r", true);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Server cleared "A" at ver=21, then foreign client "other" saved "A B" at ver=22 (overwriting `draftMeta.clientId` to "other")!
    const snapForeign = makeSnapshot(3, { [key2]: "A B" });
    snapForeign.draftMeta = { [key2]: { ver: 22, clientId: "other", clientSeq: 1 } };
    pushWait2(snapForeign);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Now our clear reply (`draftVer: 21 < 22`) arrives: must preserve full `"A B"` (never clobbering server with `" B"`)!
    resolveSend2({
      ok: true,
      revision: 2,
      draftCleared: true,
      draftVer: 21,
    });
    await pSend2;
    client2.endPendingSend(key2);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(client2.getDraft(key2)).toBe("A B");
    expect(savedOnKey2).toEqual([]);

    // 3. Version-scoped `ackedWriteEchoes` + `persistError` clear retry:
    const key3 = "mini|s1|p17";
    let pushWait3!: (snap: FleetSnapshot) => void;
    let verCounter = 30;
    const actionLog3: RexAction[] = [];

    const client3 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(1, {});
        snap.draftMeta = {};
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait3 = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        actionLog3.push(act);
        if (act.op === "save_draft") {
          verCounter++;
          return Promise.resolve({
            ok: true,
            revision: verCounter,
            draftVer: verCounter,
            clientId: act.clientId,
            clientSeq: act.clientSeq,
          } as unknown as T);
        }
        if (act.op === "send_input") {
          verCounter++;
          return Promise.resolve({
            ok: true,
            revision: verCounter,
            draftCleared: true,
            draftVer: verCounter,
            clientId: act.clientId,
            clientSeq: act.clientSeq,
            persistError: "清理草稿落盘失败: EIO",
          } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });
    client3.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Multi-chunk save (`>1020B` across 2 chunks): chunk 0 commits at ver 31, chunk 1 commits at ver 32.
    const longDraft = "首段分片".repeat(260);
    await client3.saveDraft(key3, longDraft);
    const saveChunks = actionLog3.filter(a => a.op === "save_draft") as Extract<RexAction, { op: "save_draft" }>[];
    expect(saveChunks.length).toBeGreaterThanOrEqual(2);
    const chunk0Text = saveChunks[0]!.text;

    // Another client now overwrites server draft back to `chunk0Text` at newer `ver: verCounter + 1`:
    // Must NOT be suppressed as a stale local echo from chunk 0's earlier commit version!
    verCounter++;
    const snapRevert = makeSnapshot(verCounter + 10, { [key3]: chunk0Text });
    snapRevert.draftMeta = { [key3]: { ver: verCounter, clientId: "other", clientSeq: 1 } };
    pushWait3(snapRevert);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(client3.getDraft(key3)).toBe(chunk0Text);

    // Send with `persistError` returns `ok: true` (never resends input) AND triggers idempotent `saveDraft(key3, "")` retry!
    const countBeforeSend = actionLog3.length;
    const sendRes = await client3.sendInput(key3, `${chunk0Text}\r`, true);
    expect(sendRes.ok).toBe(true);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const afterSendActions = actionLog3.slice(countBeforeSend);
    expect(afterSendActions.filter(a => a.op === "send_input").length).toBe(1);
    expect(afterSendActions.some(a => a.op === "save_draft" && a.text === "")).toBe(true);

    // 4. Pre-reply chunk 0 latch survives subsequent foreign clear snapshot before chunk 0 HTTP reply arrives:
    const key4 = "mini|s1|p18";
    let pushWait4!: (snap: FleetSnapshot) => void;
    let resolveChunk0!: (reply: ActionReply) => void;
    let chunk0Cid: string | undefined;
    let chunk0Seq: number | undefined;
    let chunk0SentText = "";
    let saveCalls4 = 0;

    const client4 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(1, {});
        snap.draftMeta = {};
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait4 = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "save_draft" && act.key === key4) {
          saveCalls4++;
          if (saveCalls4 === 1) {
            chunk0Cid = act.clientId;
            chunk0Seq = act.clientSeq;
            chunk0SentText = act.text;
            return new Promise<T>(r => {
              resolveChunk0 = rep => r(rep as unknown as T);
            });
          }
          return Promise.resolve({
            ok: true,
            conflict: true,
            revision: 3,
            draftVer: 2,
            clientId: "other",
            clientSeq: 1,
            serverDraft: "",
          } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });
    client4.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const pLong4 = client4.saveDraft(key4, "分片测试".repeat(260));
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Snapshot 1 arrives BEFORE chunk 0 HTTP reply, proving chunk 0 committed on server (`ver: 1, clientId: chunk0Cid, clientSeq: chunk0Seq`):
    const snapChunk0 = makeSnapshot(2, { [key4]: chunk0SentText });
    snapChunk0.draftMeta = { [key4]: { ver: 1, clientId: chunk0Cid, clientSeq: chunk0Seq! } };
    pushWait4(snapChunk0);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Snapshot 2 arrives STILL before chunk 0 HTTP reply: foreign client cleared draft (`ver: 2, clientId: "other", clientSeq: 1`)!
    const snapForeignClear = makeSnapshot(3, {});
    snapForeignClear.draftMeta = { [key4]: { ver: 2, clientId: "other", clientSeq: 1 } };
    pushWait4(snapForeignClear);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Now chunk 0 HTTP reply arrives; save aborts without resurrecting the cleared multi-chunk draft!
    resolveChunk0({
      ok: true,
      revision: 2,
      draftVer: 1,
      clientId: chunk0Cid,
      clientSeq: chunk0Seq,
    });
    await pLong4;
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(client4.getDraft(key4)).toBe("");
    expect(saveCalls4).toBe(1);
  });

  test("(n) delayed chunk0 ACK after foreign clear, no stale clear marker after post-clear X, clear-conflict identical 'A', and snapshot-acked send timeout", async () => {
    // 1. Start at server "A" (v1), save multi-chunk "A" + "B...", foreign clear (v3) arrives BEFORE chunk0 ACK (v2) AND before any v2 snapshot:
    const key1 = "mini|s1|p19";
    let pushWait1!: (snap: FleetSnapshot) => void;
    let resolveChunk0_1!: (reply: ActionReply) => void;
    const savedOn1: string[] = [];

    const client1 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(1, { [key1]: "A" });
        snap.draftMeta = { [key1]: { ver: 1, clientId: "seed", clientSeq: 1 } };
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait1 = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "save_draft" && act.key === key1) {
          savedOn1.push(act.text);
          if (savedOn1.length === 1) {
            return new Promise<T>(r => {
              resolveChunk0_1 = rep => r(rep as unknown as T);
            });
          }
          return Promise.resolve({ ok: true, revision: 10, draftVer: 4 } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });
    client1.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const pSave1 = client1.saveDraft(key1, "A" + "续写内容".repeat(260));
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Foreign clear at v3 arrives BEFORE chunk 0 HTTP reply (which committed at v2) and with v2 snapshot skipped!
    const snapClear1 = makeSnapshot(3, {});
    snapClear1.draftMeta = { [key1]: { ver: 3, clientId: "other", clientSeq: 1 } };
    pushWait1(snapClear1);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // User also types "!" after the save target was queued: ONLY "!" should survive and be saved!
    client1.setLocalDraft(key1, client1.getDraft(key1) + "!", { dirty: true });

    // Now delayed chunk 0 ACK arrives (`draftVer: 2 < 3`): must strip the superseded multi-chunk target and save ONLY "!"!
    resolveChunk0_1({ ok: true, revision: 2, draftVer: 2 });
    await pSave1;
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(client1.getDraft(key1)).toBe("!");
    expect(savedOn1.length).toBe(2);
    expect(savedOn1[1]).toBe("!");

    // 2. Delayed send clear reply (`v2`) after post-clear snapshot `X` (`v3`) must NOT install stale pendingClearEcho (so typing `!` + snapshot `XY` at `v4` yields `X!Y`, NOT `X!XY`):
    const key2 = "mini|s1|p20";
    let pushWait2!: (snap: FleetSnapshot) => void;
    let resolveSend2!: (reply: ActionReply) => void;
    let sendCid2: string | undefined;
    let sendSeq2: number | undefined;
    const savedOn2: string[] = [];

    const client2 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(1, { [key2]: "OLD" });
        snap.draftMeta = { [key2]: { ver: 1, clientId: "seed", clientSeq: 1 } };
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait2 = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "send_input" && act.key === key2) {
          sendCid2 = act.clientId;
          sendSeq2 = act.clientSeq;
          return new Promise<T>(r => {
            resolveSend2 = rep => r(rep as unknown as T);
          });
        }
        if (act.op === "save_draft" && act.key === key2) {
          savedOn2.push(act.text);
          return Promise.resolve({ ok: true, revision: 10, draftVer: 5 } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });
    client2.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(client2.beginPendingSend(key2, "OLD")).toBe(true);
    const pSend2 = client2.sendInput(key2, "OLD\r", true);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Post-clear ASR `X` at v3 arrives before clear reply (v2):
    const snapX = makeSnapshot(3, { [key2]: "X" });
    snapX.draftMeta = { [key2]: { ver: 3, clientId: sendCid2, clientSeq: sendSeq2! } };
    pushWait2(snapX);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Delayed clear reply at v2 arrives:
    resolveSend2({
      ok: true,
      revision: 2,
      draftCleared: true,
      draftVer: 2,
      clientId: sendCid2,
      clientSeq: sendSeq2,
    });
    await pSend2;
    client2.endPendingSend(key2);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(client2.getDraft(key2)).toBe("X");

    // User types `!` (`X!`), then next ASR snapshot `XY` arrives at v4: must merge to `X!Y`, NOT `X!XY`!
    client2.setLocalDraft(key2, "X!", { dirty: true });
    const snapXY = makeSnapshot(4, { [key2]: "XY" });
    snapXY.draftMeta = { [key2]: { ver: 4, clientId: sendCid2, clientSeq: sendSeq2! } };
    pushWait2(snapXY);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(client2.getDraft(key2)).toBe("X!Y");
    expect(savedOn2).toEqual(["X!Y"]);

    // 3. Refused clear (`draftCleared: false`) with identical `serverDraft: "A"` at newer version (another client cleared & wrote fresh "A"):
    const key3 = "mini|s1|p21";
    let pushWait3!: (snap: FleetSnapshot) => void;
    const client3 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(1, { [key3]: "A" });
        snap.draftMeta = { [key3]: { ver: 1, clientId: "seed", clientSeq: 1 } };
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait3 = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "send_input" && act.key === key3) {
          return Promise.resolve({
            ok: true,
            revision: 3,
            draftCleared: false,
            draftVer: 3,
            clientId: "other",
            clientSeq: 2,
            serverDraft: "A",
          } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });
    client3.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(client3.beginPendingSend(key3, "A")).toBe(true);
    await client3.sendInput(key3, "A\r", true);
    client3.endPendingSend(key3);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(client3.getDraft(key3)).toBe("A");
    // Subsequent snapshot at v3 keeps "A":
    const snapSameA = makeSnapshot(3, { [key3]: "A" });
    snapSameA.draftMeta = { [key3]: { ver: 3, clientId: "other", clientSeq: 2 } };
    pushWait3(snapSameA);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(client3.getDraft(key3)).toBe("A");

    // 4. Snapshot acknowledges `(clientId, writeSeq)` before `send_input` HTTP response times out:
    const key4 = "mini|s1|p22";
    let pushWait4!: (snap: FleetSnapshot) => void;
    let rejectSend4!: (err: Error) => void;
    let sendCid4: string | undefined;
    let sendSeq4: number | undefined;

    const client4 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(1, { [key4]: "CMD" });
        snap.draftMeta = { [key4]: { ver: 1, clientId: "seed", clientSeq: 1 } };
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait4 = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "send_input" && act.key === key4) {
          sendCid4 = act.clientId;
          sendSeq4 = act.clientSeq;
          return new Promise<T>((_r, rej) => {
            rejectSend4 = rej;
          });
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });
    client4.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(client4.beginPendingSend(key4, "CMD")).toBe(true);
    const pSend4 = client4.sendInput(key4, "CMD\r", true);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Server delivered "CMD\r" and published snapshot acknowledging `(sendCid4, sendSeq4)` at v2:
    const snapAck4 = makeSnapshot(2, {});
    snapAck4.draftMeta = { [key4]: { ver: 2, clientId: sendCid4, clientSeq: sendSeq4! } };
    pushWait4(snapAck4);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // HTTP action transport then fails with timeout: `sendInput` settles `ok: true` instead of restoring "CMD"!
    rejectSend4(new Error("request timed out"));
    const res4 = await pSend4;
    client4.endPendingSend(key4);
    expect(res4.ok).toBe(true);
    expect(client4.getDraft(key4)).toBe("");
  });

  test("(o) chunk0 timeout preserves unsaved 'B', queued 'ABC' invalidated on clear, untouched-pane clear, post-timeout snapshot ack, and foreign replacement 'X'->'X' idempotency", async () => {
    // 1. Chunk 0 timeout (never committed, no draftVer) after foreign clear of `A` MUST preserve `B`!
    const key1 = "mini|s1|p23";
    let pushWait1!: (snap: FleetSnapshot) => void;
    let rejectChunk0_1!: (err: Error) => void;

    const client1 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(1, { [key1]: "A" });
        snap.draftMeta = { [key1]: { ver: 1, clientId: "seed", clientSeq: 1 } };
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait1 = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "save_draft" && act.key === key1) {
          return new Promise<T>((_r, rej) => {
            rejectChunk0_1 = rej;
          });
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });
    client1.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const pSave1 = client1.saveDraft(key1, "AB");
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const snapClear1 = makeSnapshot(2, {});
    snapClear1.draftMeta = { [key1]: { ver: 2, clientId: "other", clientSeq: 1 } };
    pushWait1(snapClear1);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    rejectChunk0_1(new Error("timeout"));
    const r1 = await pSave1;
    expect(r1.ok).toBe(false);
    expect(client1.getDraft(key1)).toBe("B");

    // 2. Queued `saveDraft("ABC")` while `saveDraft("AB")` awaits chunk 0 + foreign clear after chunk 0 committed -> replaces queued `"ABC"` with `"C"`!
    const key2 = "mini|s1|p24";
    let pushWait2!: (snap: FleetSnapshot) => void;
    let resolveChunk0_2!: (reply: ActionReply) => void;
    const savedOn2: Extract<RexAction, { op: "save_draft" }>[] = [];

    const client2 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(1, { [key2]: "A" });
        snap.draftMeta = { [key2]: { ver: 1, clientId: "seed", clientSeq: 1 } };
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait2 = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "save_draft" && act.key === key2) {
          savedOn2.push(act);
          if (savedOn2.length === 1) {
            return new Promise<T>(r => {
              resolveChunk0_2 = rep => r(rep as unknown as T);
            });
          }
          return Promise.resolve({ ok: true, revision: 5, draftVer: 4, clientId: act.clientId, clientSeq: act.clientSeq } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });
    client2.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const pAB = client2.saveDraft(key2, "AB");
    for (let i = 0; i < 2; i++) await Promise.resolve();
    const pABC = client2.saveDraft(key2, "ABC");
    for (let i = 0; i < 2; i++) await Promise.resolve();

    const snapClear2 = makeSnapshot(3, {});
    snapClear2.draftMeta = { [key2]: { ver: 3, clientId: "other", clientSeq: 1 } };
    pushWait2(snapClear2);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    resolveChunk0_2({ ok: true, revision: 2, draftVer: 2 });
    await pAB;
    const rABC = await pABC;
    expect(rABC.ok).toBe(true);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(client2.getDraft(key2)).toBe("C");
    expect(savedOn2.map(a => a.text)).toEqual(["AB", "C"]);
    expect(savedOn2[1]!.ifDraftVer).toBe(3);

    // 3. Previously untouched pane (omitted from bootstrap `draftMeta`): chunk 0 commits at v1, foreign clear at v2 arrives first -> clears local draft!
    const key3 = "mini|s1|untouched";
    let pushWait3!: (snap: FleetSnapshot) => void;
    let resolveChunk0_3!: (reply: ActionReply) => void;

    const client3 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(1, {});
        snap.draftMeta = {}; // `key3` omitted!
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait3 = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "save_draft" && act.key === key3) {
          return new Promise<T>(r => {
            resolveChunk0_3 = rep => r(rep as unknown as T);
          });
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });
    client3.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const pUntouched = client3.saveDraft(key3, "FIRST");
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const snapClearUntouched = makeSnapshot(2, {});
    snapClearUntouched.draftMeta = { [key3]: { ver: 2, clientId: "other", clientSeq: 1 } };
    pushWait3(snapClearUntouched);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    resolveChunk0_3({ ok: true, revision: 2, draftVer: 1 });
    await pUntouched;
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(client3.getDraft(key3)).toBe("");

    // 4. HTTP timeout arrives BEFORE `/rex/wait` snapshot carrying `(clientId, writeSeq)` (and `/rex/bootstrap` probe also fails), followed by delayed wait snapshot:
    const key4 = "mini|s1|p25";
    let pushWait4!: (snap: FleetSnapshot) => void;
    let rejectSend4!: (err: Error) => void;
    let bootCount4 = 0;
    let sendCid4: string | undefined;
    let sendSeq4: number | undefined;

    const client4 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        bootCount4++;
        if (bootCount4 === 1) {
          const snap = makeSnapshot(1, { [key4]: "CMD" });
          snap.draftMeta = { [key4]: { ver: 1, clientId: "seed", clientSeq: 1 } };
          return Promise.resolve(snap as unknown as T);
        }
        return Promise.reject(new Error("probe timeout"));
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait4 = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "send_input" && act.key === key4) {
          sendCid4 = act.clientId;
          sendSeq4 = act.clientSeq;
          return new Promise<T>((_r, rej) => {
            rejectSend4 = rej;
          });
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });
    client4.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(client4.beginPendingSend(key4, "CMD")).toBe(true);
    const pSend4 = client4.sendInput(key4, "CMD\r", true);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // HTTP timeout happens FIRST (and probe also fails) -> marked `unconfirmed: true` and stays locked out of retryable draft!
    rejectSend4(new Error("HTTP timeout"));
    const res4 = await pSend4;
    client4.endPendingSend(key4);
    expect(res4.ok).toBe(false);
    expect(res4.unconfirmed).toBe(true);
    expect(client4.isUnconfirmedSend(key4)).toBe(true);
    expect(client4.isSending(key4)).toBe(true);

    // Delayed `/rex/wait` snapshot now arrives carrying `(sendCid4, sendSeq4)` -> automatically settles delivery and clears draft!
    const snapDelayedAck = makeSnapshot(2, {});
    snapDelayedAck.draftMeta = { [key4]: { ver: 2, clientId: sendCid4, clientSeq: sendSeq4! } };
    pushWait4(snapDelayedAck);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(client4.isUnconfirmedSend(key4)).toBe(false);
    expect(client4.isSending(key4)).toBe(false);
    expect(client4.getDraft(key4)).toBe("");

    // 5. Foreign write `X` followed by another foreign replacement `X` during pending send -> settles to `X` (NOT `XX`):
    const key5 = "mini|s1|p26";
    let pushWait5!: (snap: FleetSnapshot) => void;
    let resolveSend5!: (reply: ActionReply) => void;
    const savedOn5: string[] = [];

    const client5 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(1, { [key5]: "A" });
        snap.draftMeta = { [key5]: { ver: 1, clientId: "seed", clientSeq: 1 } };
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait5 = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "send_input" && act.key === key5) {
          return new Promise<T>(r => {
            resolveSend5 = rep => r(rep as unknown as T);
          });
        }
        if (act.op === "save_draft" && act.key === key5) {
          savedOn5.push(act.text);
          return Promise.resolve({ ok: true, revision: 10, draftVer: 4 } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });
    client5.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    expect(client5.beginPendingSend(key5, "A")).toBe(true);
    const pSend5 = client5.sendInput(key5, "A\r", true);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const sX1 = makeSnapshot(2, { [key5]: "X" });
    sX1.draftMeta = { [key5]: { ver: 2, clientId: "other", clientSeq: 1 } };
    pushWait5(sX1);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const sX2 = makeSnapshot(3, { [key5]: "X" });
    sX2.draftMeta = { [key5]: { ver: 3, clientId: "other", clientSeq: 2 } };
    pushWait5(sX2);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    resolveSend5({
      ok: true,
      revision: 3,
      draftCleared: false,
      draftVer: 3,
      clientId: "other",
      clientSeq: 2,
      serverDraft: "X",
    });
    await pSend5;
    client5.endPendingSend(key5);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(client5.getDraft(key5)).toBe("X");
    expect(savedOn5).toEqual([]);
  });

  test("(p) exact per-seq sendOutcomes across panes, affirmative not_sent restore, execution-time unconfirmed lock, persisted ^U discard, and followupPromise error propagation", async () => {
    // 1. Pane A times out unconfirmed (bootstrap has no sendOutcomes entry -> stays unconfirmed, NEVER inferred failed from absence!);
    //    Pane B then sends successfully with a higher sequence -> MUST NOT settle Pane A!
    //    User then presses ^U (`resolveUnconfirmedSend(paneA, "discard")`) -> persists `saveDraft(paneA, "")` against server draft!
    const paneA = "mini|s1|paneA";
    const paneB = "mini|s1|paneB";
    let pushWait1!: (snap: FleetSnapshot) => void;
    let cid1 = "";
    let seqA = 0;
    const actions1: RexAction[] = [];

    const client1 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(1, { [paneA]: "CMD_A", [paneB]: "CMD_B" });
        snap.draftMeta = {
          [paneA]: { ver: 1, clientId: "seed", clientSeq: 1 },
          [paneB]: { ver: 2, clientId: "seed", clientSeq: 1 },
        };
        snap.sendOutcomes = {}; // Absent entry for `seqA` MUST NOT be treated as proven not-delivered!
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait1 = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        actions1.push(act);
        if (act.op === "send_input" && act.key === paneA) {
          cid1 = act.clientId!;
          seqA = act.clientSeq!;
          return Promise.reject(new Error("transport timeout"));
        }
        if (act.op === "send_input" && act.key === paneB) {
          const seqB = act.clientSeq!;
          return Promise.resolve({
            ok: true,
            revision: 3,
            draftCleared: true,
            draftVer: 3,
            clientId: act.clientId,
            clientSeq: seqB,
          } as unknown as T);
        }
        if (act.op === "save_draft") {
          return Promise.resolve({
            ok: true,
            revision: 5,
            draftVer: 4,
            clientId: act.clientId,
            clientSeq: act.clientSeq,
          } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });
    client1.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Queue a second sendInput on paneA right behind the first BEFORE the first times out:
    const pFirstA = client1.sendInput(paneA, "CMD_A\r", true);
    const pSecondA = client1.sendInput(paneA, "CMD_A_DUP\r", true);
    const rFirstA = await pFirstA;
    const rSecondA = await pSecondA;
    expect(rFirstA.ok).toBe(false);
    expect(rFirstA.unconfirmed).toBe(true);
    // Second queued sendInput MUST be blocked at execution time!
    expect(rSecondA.ok).toBe(false);
    expect(rSecondA.unconfirmed).toBe(true);
    expect(actions1.filter(a => a.op === "send_input" && a.key === paneA).length).toBe(1);

    // `saveDraft` on paneA while parked unconfirmed is ALSO blocked:
    const blockedSave = await client1.saveDraft(paneA, "CLOBBER");
    expect(blockedSave.ok).toBe(false);
    expect(blockedSave.unconfirmed).toBe(true);

    // Pane B sends with higher sequence `seqB > seqA` and snapshot publishes `sendOutcomes["cid1:seqB"]`:
    const rB = await client1.sendInput(paneB, "CMD_B\r", true);
    expect(rB.ok).toBe(true);
    const snapAfterB = makeSnapshot(4, { [paneA]: "CMD_A" });
    snapAfterB.draftMeta = {
      [paneA]: { ver: 1, clientId: "seed", clientSeq: 1 },
      [paneB]: { ver: 3, clientId: cid1, clientSeq: seqA + 1 },
    };
    snapAfterB.sendOutcomes = {
      [`${cid1}:${seqA + 1}`]: { ok: true, draftCleared: true, draftVer: 3 },
    };
    pushWait1(snapAfterB);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    // Pane A MUST still be parked unconfirmed!
    expect(client1.isUnconfirmedSend(paneA)).toBe(true);

    // Explicit `^U` discard (`resolveUnconfirmedSend(paneA, "discard")`) persists `saveDraft(paneA, "")` since server still held "CMD_A":
    client1.resolveUnconfirmedSend(paneA, "discard");
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(client1.isUnconfirmedSend(paneA)).toBe(false);
    expect(client1.getDraft(paneA)).toBe("");
    expect(actions1.some(a => a.op === "save_draft" && a.key === paneA && a.text === "")).toBe(true);

    // 2. Affirmative `sendOutcomes["cid:seq"] = { ok: false }` restores timed-out send, AND `followupPromise` propagates error to original `saveDraft` caller:
    const key2 = "mini|s1|paneC";
    let cid2 = "";
    let seq2 = 0;
    let boot2 = 0;
    let saveStep2 = 0;
    let pushWait2!: (snap: FleetSnapshot) => void;
    let resolveChunk0_2!: (reply: ActionReply) => void;

    const client2 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        boot2++;
        const snap = makeSnapshot(boot2, { [key2]: "A" });
        snap.draftMeta = { [key2]: { ver: 1, clientId: "seed", clientSeq: 1 } };
        if (boot2 > 1 && cid2) {
          snap.sendOutcomes = { [`${cid2}:${seq2}`]: { ok: false } };
        }
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait2 = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "send_input") {
          cid2 = act.clientId!;
          seq2 = act.clientSeq!;
          return Promise.reject(new Error("transport timeout"));
        }
        if (act.op === "save_draft" && act.key === key2) {
          saveStep2++;
          if (saveStep2 === 1) {
            return new Promise<T>(r => {
              resolveChunk0_2 = rep => r(rep as unknown as T);
            });
          }
          return Promise.resolve({ ok: false, error: "ENOSPC followup" } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });
    client2.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Affirmative `{ ok: false }` in `/rex/bootstrap` returns non-unconfirmed error so caller can restore & retry!
    const rNotSent = await client2.sendInput(key2, "A\r", true);
    expect(rNotSent.ok).toBe(false);
    expect(rNotSent.unconfirmed).toBeUndefined();

    // Delayed chunk-0 ACK (`ok: true`) scheduling `followupPromise` for surviving `"!"` propagates `ENOSPC followup` to original caller AND bumps `externalDraftSeq`!
    const pSaveOrig = client2.saveDraft(key2, "A" + "长段".repeat(300));
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const snapClr = makeSnapshot(10, {});
    snapClr.draftMeta = { [key2]: { ver: 3, clientId: "other", clientSeq: 1 } };
    pushWait2(snapClr);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const extSeqBeforeAck = client2.externalDraftSeq(key2);
    client2.setLocalDraft(key2, client2.getDraft(key2) + "!", { dirty: true });

    resolveChunk0_2({ ok: true, revision: 9, draftVer: 2 });
    const origOutcome = await pSaveOrig;
    expect(origOutcome.ok).toBe(false);
    expect(origOutcome.error).toContain("ENOSPC followup");
    expect(client2.externalDraftSeq(key2)).toBeGreaterThan(extSeqBeforeAck);
  });

  test("(q) send_key blocked while unconfirmed, chunk0 persist-error still replays surviving edit after clear, delayed sendOutcome persistError retry, and bootId engine restart rebase", async () => {
    // 1. `send_key` blocked while unconfirmed + delayed `sendOutcomes` carrying `persistError` triggers `saveDraft(key, "")` retry:
    const key1 = "mini|s1|p27";
    let pushWait1!: (snap: FleetSnapshot) => void;
    let cid1 = "";
    let seq1 = 0;
    let bootCalls1 = 0;
    const actions1: RexAction[] = [];

    const client1 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        bootCalls1++;
        if (bootCalls1 === 1) {
          const snap = makeSnapshot(50, { [key1]: "CMD" });
          snap.bootId = "engine-1";
          snap.draftMeta = { [key1]: { ver: 20, clientId: "seed", clientSeq: 1 } };
          return Promise.resolve(snap as unknown as T);
        }
        return Promise.reject(new Error("probe timeout"));
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait1 = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        actions1.push(act);
        if (act.op === "send_input" && act.key === key1) {
          cid1 = act.clientId!;
          seq1 = act.clientSeq!;
          return Promise.reject(new Error("timeout"));
        }
        if (act.op === "save_draft") {
          return Promise.resolve({ ok: true, revision: 52, draftVer: 22, bootId: "engine-1" } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true, bootId: "engine-1" } as unknown as T);
    });
    client1.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const rSend1 = await client1.sendInput(key1, "CMD\r", true);
    expect(rSend1.unconfirmed).toBe(true);
    // `send_key` (e.g. Enter passthrough after hiding drawer) MUST be blocked while unconfirmed!
    const rKey = await client1.dispatchAction({ op: "send_key", key: key1, keyName: "Enter" });
    expect(rKey.ok).toBe(false);
    expect(rKey.unconfirmed).toBe(true);

    // Delayed snapshot delivers `sendOutcomes["cid1:seq1"]` WITH `persistError`: settles send AND triggers `saveDraft(key1, "")` retry!
    const snapOut1 = makeSnapshot(51, {});
    snapOut1.bootId = "engine-1";
    snapOut1.draftMeta = { [key1]: { ver: 21, clientId: cid1, clientSeq: seq1 } };
    snapOut1.sendOutcomes = {
      [`${cid1}:${seq1}`]: {
        ok: true,
        draftCleared: true,
        draftVer: 21,
        persistError: "清理草稿落盘失败: EIO",
      },
    };
    pushWait1(snapOut1);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(client1.isUnconfirmedSend(key1)).toBe(false);
    expect(actions1.some(a => a.op === "save_draft" && a.key === key1 && a.text === "")).toBe(true);

    // Engine restarts (`bootId: "engine-2"`, `revision: 1 < 52`, `ver: 1 < 22`): snapshot MUST be accepted and rebased!
    const snapRestart = makeSnapshot(1, { [key1]: "重启后新草稿" });
    snapRestart.bootId = "engine-2";
    snapRestart.draftMeta = { [key1]: { ver: 1, clientId: "other", clientSeq: 1 } };
    pushWait1(snapRestart);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(client1.getDraft(key1)).toBe("重启后新草稿");

    // 2. Chunk 0 committed in memory (`draftVer: 1`) with disk persistence error (`ok: false`) after foreign clear (`ver: 2`) still replays surviving `"B"`!
    const key2 = "mini|s1|p28";
    let pushWait2!: (snap: FleetSnapshot) => void;
    let resolveChunk0_2!: (reply: ActionReply) => void;
    const savedOn2: string[] = [];

    const client2 = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(1, {});
        snap.draftMeta = {};
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait2 = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        if (act.op === "save_draft" && act.key === key2) {
          savedOn2.push(act.text);
          if (savedOn2.length === 1) {
            return new Promise<T>(r => {
              resolveChunk0_2 = rep => r(rep as unknown as T);
            });
          }
          return Promise.resolve({ ok: true, revision: 4, draftVer: 3 } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true } as unknown as T);
    });
    client2.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const pSave2 = client2.saveDraft(key2, "首段".repeat(300));
    for (let i = 0; i < 4; i++) await Promise.resolve();
    client2.setLocalDraft(key2, client2.getDraft(key2) + "B", { dirty: true });

    // Foreign clear at v2 (empty -> empty on untouched pane) arrives before chunk 0 reply:
    const snapClr2 = makeSnapshot(2, {});
    snapClr2.draftMeta = { [key2]: { ver: 2, clientId: "other", clientSeq: 1 } };
    pushWait2(snapClr2);
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Chunk 0 reply arrives with in-memory commit `draftVer: 1` AND persistence failure `ok: false`: surviving `"B"` MUST still be persisted!
    resolveChunk0_2({ ok: false, error: "EIO", revision: 1, draftVer: 1 });
    const rFinal2 = await pSave2;
    expect(rFinal2.ok).toBe(true);
    expect(client2.getDraft(key2)).toBe("B");
    expect(savedOn2[savedOn2.length - 1]).toBe("B");
  });

  test("(r) bootId precondition binding, retired boot rejection, no 'ABB' duplication on persisted restart, parked-send 'AX' across restart, and clean rebase save-target refresh", async () => {
    const key1 = "mini|s1|p29";
    const keyParked = "mini|s1|p30";
    const keyClean = "mini|s1|p31";
    let pushWait!: (snap: FleetSnapshot) => void;
    let resolveSaveAB!: (reply: ActionReply) => void;
    const postedActions: RexAction[] = [];

    let bootPhase = 1;
    const client = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        if (bootPhase === 1) {
          const snap = makeSnapshot(10, { [key1]: "A", [keyParked]: "A", [keyClean]: "A" });
          snap.bootId = "boot-A";
          snap.draftMeta = {
            [key1]: { ver: 1, clientId: "seed", clientSeq: 1 },
            [keyParked]: { ver: 1, clientId: "seed", clientSeq: 1 },
            [keyClean]: { ver: 1, clientId: "seed", clientSeq: 1 },
          };
          return Promise.resolve(snap as unknown as T);
        }
        return Promise.reject(new Error("probe timeout"));
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        postedActions.push(act);
        if (act.op === "save_draft" && act.key === keyClean) {
          return Promise.resolve({ ok: true, bootId: bootPhase === 1 ? "boot-A" : "boot-B", revision: 11, draftVer: 2 } as unknown as T);
        }
        if (act.op === "send_input" && act.key === keyParked) {
          return Promise.reject(new Error("transport timeout"));
        }
        if (act.op === "save_draft" && act.key === key1) {
          if (act.ifBootId === "boot-A") {
            return new Promise<T>(r => {
              resolveSaveAB = rep => r(rep as unknown as T);
            });
          }
          return Promise.resolve({ ok: true, bootId: "boot-B", revision: 5, draftVer: 3 } as unknown as T);
        }
        if (act.op === "save_draft" && act.key === keyParked) {
          return Promise.resolve({ ok: true, bootId: "boot-B", revision: 6, draftVer: 3 } as unknown as T);
        }
      }
      return Promise.resolve({ ok: true, bootId: "boot-B" } as unknown as T);
    });
    client.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // Save "A" on `keyClean` so `lastQueuedSaveTarget` caches "A" on `boot-A`:
    await client.saveDraft(keyClean, "A");
    expect(client.getLastQueuedSaveTarget(keyClean)).toBe("A");

    // Park an unconfirmed send of "A" on `keyParked`:
    bootPhase = 2; // probe fails -> parked unconfirmed
    const rParked = await client.sendInput(keyParked, "A\r", true);
    expect(rParked.unconfirmed).toBe(true);
    // Verify `ifBootId: "boot-A"` was attached to the versioned send_input!
    const parkedSendAct = postedActions.find(a => a.op === "send_input" && a.key === keyParked) as Extract<RexAction, { op: "send_input" }>;
    expect(parkedSendAct.ifBootId).toBe("boot-A");

    // Start saving "AB" on `key1` (carries `ifBootId: "boot-A"`), and engine restarts to `boot-B` having ALREADY persisted "AB"!
    const pSaveAB = client.saveDraft(key1, "AB");
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const saveABAct = postedActions.find(a => a.op === "save_draft" && a.key === key1) as Extract<RexAction, { op: "save_draft" }>;
    expect(saveABAct.ifBootId).toBe("boot-A");

    // `boot-B` publishes its first snapshot: `key1` has "AB", `keyParked` has "AX", `keyClean` has "B"!
    const snapBootB = makeSnapshot(1, { [key1]: "AB", [keyParked]: "AX", [keyClean]: "B" });
    snapBootB.bootId = "boot-B";
    snapBootB.draftMeta = {
      [key1]: { ver: 1 },
      [keyParked]: { ver: 2 },
      [keyClean]: { ver: 1 },
    };
    pushWait(snapBootB);
    for (let i = 0; i < 6; i++) await Promise.resolve();

    // 1. `key1` MUST NOT duplicate "B" into "ABB"!
    expect(client.getDraft(key1)).toBe("AB");
    // 2. `keyClean` refreshed `getLastQueuedSaveTarget` to "B" (so editing back to "A" is recognized as needing save)!
    expect(client.getDraft(keyClean)).toBe("B");
    expect(client.getLastQueuedSaveTarget(keyClean)).toBe("B");

    // 3. Delayed snapshot and delayed action reply from retired `boot-A` MUST be rejected without switching back to `boot-A`!
    const staleSnapBootA = makeSnapshot(99, { [keyClean]: "STALE_FROM_BOOT_A" });
    staleSnapBootA.bootId = "boot-A";
    staleSnapBootA.draftMeta = { [keyClean]: { ver: 99 } };
    pushWait(staleSnapBootA);
    resolveSaveAB({ ok: true, bootId: "boot-A", revision: 99, draftVer: 99 });
    await pSaveAB;
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(client.getDraft(keyClean)).toBe("B");
    expect(client.getDraft(key1)).toBe("AB");
    expect(postedActions.filter(a => a.op === "save_draft" && a.key === key1).length).toBe(1);

    // 4. `keyParked` preserved external `"X"` across restart while retaining send lock: discarding (`^U`) keeps `"X"`!
    expect(client.isUnconfirmedSend(keyParked)).toBe(true);
    client.resolveUnconfirmedSend(keyParked, "discard");
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(client.getDraft(keyParked)).toBe("X");
  });

  test("(s) enforces 16KiB/96KiB/64KiB byte caps, replays unpersisted save across restart, and isolates uncommitted foreign provisional chunks", async () => {
    const kMain = "mini|s1|cap-main";
    const kConc1 = "mini|s1|cap-conc1";
    const kConc2 = "mini|s1|cap-conc2";
    const kObserver = "mini|s1|prov-obs";
    const kReplay = "mini|s1|restart-replay";
    const big15K = "z".repeat(15 * 1024);

    let pushWait!: (snap: FleetSnapshot) => void;
    let resolveConc1!: (reply: ActionReply) => void;
    let resolveReplayBootA!: (reply: ActionReply) => void;
    let mockBoot = "boot-A";
    const posted: RexAction[] = [];

    const client = createRexClient(<T>(path: string, _m?: "GET" | "POST", body?: unknown): Promise<T> => {
      if (path === "/rex/bootstrap") {
        const snap = makeSnapshot(10, {
          [kMain]: "OLD",
          [kObserver]: "BASE",
          [kReplay]: "A",
          "fill|1": big15K,
          "fill|2": big15K,
          "fill|3": big15K,
          "fill|4": big15K,
          "fill|5": big15K,
          "fill|6": "z".repeat(12 * 1024),
        });
        snap.bootId = "boot-A";
        snap.draftMeta = { [kMain]: { ver: 1 }, [kObserver]: { ver: 1 }, [kReplay]: { ver: 1 } };
        return Promise.resolve(snap as unknown as T);
      }
      if (path.startsWith("/rex/wait")) {
        return new Promise<T>(r => {
          pushWait = s => r(s as unknown as T);
        });
      }
      if (path === "/rex/action") {
        const act = body as RexAction;
        posted.push(act);
        if (act.op === "save_draft" && act.key === kConc1 && !act.append) {
          return new Promise<T>(r => {
            resolveConc1 = rep => r(rep as unknown as T);
          });
        }
        if (act.op === "save_draft" && act.key === kReplay && act.ifBootId === "boot-A") {
          return new Promise<T>(r => {
            resolveReplayBootA = rep => r(rep as unknown as T);
          });
        }
        return Promise.resolve({
          ok: true,
          bootId: mockBoot,
          revision: 20,
          draftVer: 5,
          clientId: "clientId" in act ? act.clientId : undefined,
          clientSeq: "clientSeq" in act ? act.clientSeq : undefined,
        } as unknown as T);
      }
      return Promise.resolve({ ok: true, bootId: mockBoot } as unknown as T);
    });
    client.start();
    for (let i = 0; i < 4; i++) await Promise.resolve();

    // 1. >16 KiB per-pane draft rejected before writing chunk 0:
    const r16 = await client.saveDraft(kMain, "x".repeat(17 * 1024));
    expect(r16.ok).toBe(false);
    expect(r16.error).toContain("16 KiB");
    expect(posted.filter(a => a.op === "save_draft" && a.key === kMain).length).toBe(0);

    // 2. >64 KiB staged send rejected preflight WITHOUT cancelling queued saveDraft("keep"):
    const pKeep = client.saveDraft(kMain, "keep");
    const r64 = await client.sendInput(kMain, "y".repeat(65 * 1024), true);
    expect(r64.ok).toBe(false);
    expect(r64.error).toContain("64 KiB");
    expect((await pKeep).ok).toBe(true);
    expect(posted.some(a => a.op === "save_draft" && a.key === kMain && a.text === "keep")).toBe(true);

    // 3. >96 KiB total cross-pane draft budget rejected before writing chunk 0:
    const pConc1 = client.saveDraft(kConc1, "a".repeat(6 * 1024));
    for (let i = 0; i < 2; i++) await Promise.resolve();
    const r96 = await client.saveDraft(kConc2, "b".repeat(6 * 1024));
    expect(r96.ok).toBe(false);
    expect(r96.error).toContain("96 KiB");
    expect(posted.filter(a => a.op === "save_draft" && a.key === kConc2).length).toBe(0);
    resolveConc1({ ok: true, bootId: "boot-A", revision: 11, draftVer: 2 });
    await pConc1;

    // 4. Uncommitted foreign `provisional: true` preview is ignored until settled:
    const snapProv = makeSnapshot(12, { [kObserver]: "BASE_UNCOMMITTED_PARTIAL", [kReplay]: "A" });
    snapProv.bootId = "boot-A";
    snapProv.draftMeta = {
      [kObserver]: { ver: 2, clientId: "other", clientSeq: 1, provisional: true },
      [kReplay]: { ver: 1 },
    };
    pushWait(snapProv);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(client.getDraft(kObserver)).toBe("BASE");

    // 5. In-flight save "AB" lost across restart into `boot-B` (server still has "A") replays "AB" onto `boot-B`:
    const pReplay = client.saveDraft(kReplay, "AB");
    for (let i = 0; i < 4; i++) await Promise.resolve();
    mockBoot = "boot-B";
    const snapBootB = makeSnapshot(1, { [kObserver]: "BASE_SETTLED", [kReplay]: "A" });
    snapBootB.bootId = "boot-B";
    snapBootB.draftMeta = { [kObserver]: { ver: 1 }, [kReplay]: { ver: 1 } };
    pushWait(snapBootB);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    resolveReplayBootA({ ok: true, bootId: "boot-A", revision: 99, draftVer: 99 });
    await pReplay;
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(client.getDraft(kObserver)).toBe("BASE_SETTLED");
    expect(client.getDraft(kReplay)).toBe("AB");
    expect(
      posted.some(a => a.op === "save_draft" && a.key === kReplay && a.ifBootId === "boot-B" && a.text === "AB"),
    ).toBe(true);
  });

  test("(t) findMatchingHost prioritizes exact rexEndpoint and ignores substring/SSH shadows", async () => {
    const { findMatchingHost } = await import("../app/client.ts");
    const hosts = [
      {
        id: "backup",
        label: "backup-lab",
        kind: "tailnet" as const,
        endpoint: "https://backup-lab-rex.tail.ts.net",
        phase: "live" as const,
        sessions: [],
      },
      {
        id: "lab-ssh",
        label: "lab-rex",
        kind: "ssh" as const,
        endpoint: "ssh://user@lab-rex.tail.ts.net",
        phase: "live" as const,
        sessions: [],
      },
      {
        id: "lab-https",
        label: "lab",
        kind: "tailnet" as const,
        endpoint: "https://lab-rex.tail.ts.net:8443",
        phase: "failed" as const,
        sessions: [],
      },
    ];
    const matched = findMatchingHost(
      {
        hostName: "lab-rex",
        dnsName: "lab-rex.tail.ts.net",
        ips: [],
        online: true,
        rexEndpoint: "https://lab-rex.tail.ts.net:8443",
        alreadyAdded: true,
      },
      hosts,
    );
    expect(matched?.id).toBe("lab-https");
    expect(matched?.phase).toBe("failed");
  });

  test("shortHostLabel, primaryPaneTitle, and sanitizeDisplayText produce clean v0.1 task cards", async () => {
    const {
      primaryPaneTitle,
      sanitizeDisplayText,
      secondaryPaneSubtitle,
      shortHostLabel,
    } = await import("../app/client.ts");

    expect(shortHostLabel("Alice的Mac Mini", "https://alice-mac-mini-rex.example-tailnet.ts.net", "alice-mac-mini")).toBe("mini");
    expect(shortHostLabel("zero 本机", "unix:///run/user/1000/rex/server.sock", "local")).toBe("zero");
    expect(shortHostLabel("m1", "https://m1-rex.example-tailnet.ts.net", "m1")).toBe("m1");
    expect(shortHostLabel("MacWork", "https://macwork-rex.example-tailnet.ts.net", "macwork")).toBe("macwork");

    expect(sanitizeDisplayText("\uf110 workers (2) 🚀")).toBe("workers (2)");
    expect(sanitizeDisplayText("⇄#6 项目后端开发 · demo-app")).toBe("↔#6 项目后端开发 · demo-app");
    expect(sanitizeDisplayText("⏭#3 · 代理配置调试")).toBe("»#3 · 代理配置调试");
    expect(sanitizeDisplayText("π - hack")).toBe("π - hack");

    const hexWinPane: PaneSummary = {
      ...makePane("macwork|s1|b1", "unseen_done", 1000),
      hostLabel: "MacWork",
      sessionLabel: "wandering-glade",
      windowLabel: "Window 238279fb",
      title: "π - hack",
      program: "pi",
      pwd: "/Users/dev/hack",
    };
    expect(primaryPaneTitle(hexWinPane)).toBe("π - hack");
    expect(secondaryPaneSubtitle(hexWinPane)).toBe("pi · ~/hack");

    const agyPane: PaneSummary = {
      ...makePane("mini|s1|b1", "running", 1000),
      hostLabel: "Alice的Mac Mini",
      sessionLabel: "default",
      windowLabel: "\uf110 RexZero客户端体验修复 · rex-zero",
      title: "dev@Mac-Mini: ~/work/rex-zero",
      program: "agy",
      pwd: "/Users/dev/work/rex-zero",
      statusMsg: "正在优化一比特字库",
    };
    expect(primaryPaneTitle(agyPane)).toBe("RexZero客户端体验修复 · rex-zero");
    expect(secondaryPaneSubtitle(agyPane)).toBe("agy · 正在优化一比特字库");

    const shellPane: PaneSummary = {
      ...makePane("mini|s1|b2", "idle", 1000),
      hostLabel: "Alice的Mac Mini",
      sessionLabel: "session:1",
      windowLabel: "zsh",
      title: "dev@Mac-Mini: ~/work/rex-zero",
      program: "zsh",
      pwd: "/Users/dev/work/rex-zero",
    };
    expect(primaryPaneTitle(shellPane)).toBe("rex-zero · zsh");
    expect(secondaryPaneSubtitle(shellPane)).toBe("zsh · ~/work/rex-zero");
  });
});
