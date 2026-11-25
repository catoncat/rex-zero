import { describe, expect, test } from "bun:test";
import { deleteAtCursor, insertAtCursor, type DraftCursorLayout, moveCursorVertical } from "../app/scenes/composer-editor.ts";
import { isDesktopTuiChromeLine } from "../app/scenes/reader-layout.ts";

describe("composer-editor codepoint cursor & mid-sentence editing", () => {
  test("inserts and deletes CJK & ASCII at exact mid-sentence cursor index", () => {
    // Simulate ASR misrecognizing "Rex" as "IX": "我说的是IX识别错了。后面还有很长一段话。"
    const initial = "我说的是IX识别错了。后面还有很长一段话。";
    // Move cursor to index 6 (right after "IX")
    const d1 = deleteAtCursor(initial, 6, "back");
    expect(d1.cursor).toBe(5);
    expect(d1.text).toBe("我说的是I识别错了。后面还有很长一段话。");

    const d2 = deleteAtCursor(d1.text, d1.cursor, "back");
    expect(d2.cursor).toBe(4);
    expect(d2.text).toBe("我说的是识别错了。后面还有很长一段话。");

    const ins = insertAtCursor(d2.text, d2.cursor, "Rex");
    expect(ins.cursor).toBe(7);
    expect(ins.text).toBe("我说的是Rex识别错了。后面还有很长一段话。");
  });

  test("deleteAtCursor forward (Fn+Backspace = Delete) removes character at cursor", () => {
    const res = deleteAtCursor("AB中文CD", 2, "forward");
    expect(res.text).toBe("AB文CD");
    expect(res.cursor).toBe(2);
  });

  test("moveCursorVertical never gets stuck at softWrap row boundaries", () => {
    // Fake layout of 3 soft-wrapped rows of 4 chars each: "一二三四" / "五六七八" / "九十甲乙"
    const draft = "一二三四五六七八九十甲乙";
    const fakeSlot = 0 as never;
    // Notice `moveCursorVertical` calls `measure` when scanning >1 char; for boundary checks at x=0 (cursor=8 -> row 2 start):
    const layoutAtRow2Start: DraftCursorLayout = {
      lines: [
        { text: "一二三四", start: 0, end: 4, softWrap: true },
        { text: "五六七八", start: 4, end: 8, softWrap: true },
        { text: "九十甲乙", start: 8, end: 12, softWrap: false },
      ],
      cursor: 8,
      cursorRow: 2,
      cursorX: 0,
      totalChars: 12,
    };
    // Moving UP from row 2 x=0 (`cursor = 8`) lands on row 1 `start = 4` (`cursor < 8`!), NOT stuck at `8`!
    // At `targetX = 0`, `idx = 5` has `measure(...) >= 0`, let's verify top-row boundary behavior too:
    const layoutAtTopMid: DraftCursorLayout = {
      ...layoutAtRow2Start,
      cursor: 2,
      cursorRow: 0,
      cursorX: 32,
    };
    const toZero = moveCursorVertical(draft, layoutAtTopMid, -1, fakeSlot, null);
    expect(toZero.movedRow).toBe(true);
    expect(toZero.cursor).toBe(0);

    const atVeryStart: DraftCursorLayout = {
      ...layoutAtRow2Start,
      cursor: 0,
      cursorRow: 0,
      cursorX: 0,
    };
    const noMoreUp = moveCursorVertical(draft, atVeryStart, -1, fakeSlot, null);
    expect(noMoreUp.movedRow).toBe(false);
    expect(noMoreUp.cursor).toBe(0);
  });
});

describe("desktop TUI Swarm & telemetry chrome filtering on 320x170", () => {
  test("strips AGY Swarm footer and multi-pipe quota bars while keeping real terminal lines", () => {
    expect(
      isDesktopTuiChromeLine(
        "  ● Swarm(Rex Zero v0.2 — Memory & Test Fixes)  coordinator: @astr… · 49 posts · alt+s board",
      ),
    ).toBe(true);
    expect(
      isDesktopTuiChromeLine(
        " S2:alice  4 Carbon (High) ● working │  95 tok/s ttft 7.0s │  98% (161.9k)  4:59 │",
      ),
    ).toBe(true);
    expect(isDesktopTuiChromeLine(" ━─────── 15% 158.0k/1.0M │  5h 43% 7d 32%(5d1h)")).toBe(true);

    // Real shell prompts, commands, and conversation prose must NEVER be stripped:
    expect(isDesktopTuiChromeLine("zero@zero:~$ ls -la")).toBe(false);
    expect(isDesktopTuiChromeLine("> 为什么终端需回车才能打命令")).toBe(false);
    expect(isDesktopTuiChromeLine("Swarm worker finished task cleanly.")).toBe(false);
  });
});
