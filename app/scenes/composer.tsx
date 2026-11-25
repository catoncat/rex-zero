// Pure-black crisp Multi-Line Composer Drawer (EN / librime Pinyin / Doubao Streaming ASR).
// Supports full `Fn+F/X/Z/C` (`↑/↓/←/→`) cursor navigation, mid-sentence editing, and auto-expanding 2..4 line view.

import { For, Index, Show, createEffect, createMemo, createSignal, onCleanup, type Accessor, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { MOTION, SLOT, ellipsize, slideFrom } from "@pocketjs/framework/compact/primitives";
import { rexClient } from "../client.ts";
import { toast, useKey } from "../frame.tsx";
import { THEME, getFontPreset } from "../theme.ts";
import { layoutDraftWithCursor } from "./composer-editor.ts";
import { createComposerKeyHandler } from "./composer-keys.ts";
import { createComposerController } from "./composer-logic.ts";

const DRAFT_TEXT_MAX_W = 290;

export interface ComposerDrawerProps {
  paneKey: Accessor<string>;
  initialSeed: Accessor<string>;
  initialMode: Accessor<"en" | "ime">;
  autoStartAsr: Accessor<boolean>;
  onScrollContext?: (delta: number) => void;
  onClose: () => void;
  onSent: () => void;
  onHeightChange?: (height: number) => void;
}

export function ComposerDrawer(props: ComposerDrawerProps): JSX.Element {
  const ctrl = createComposerController({
    paneKey: props.paneKey,
    initialSeed: props.initialSeed,
    initialMode: props.initialMode,
    autoStartAsr: props.autoStartAsr,
    onClose: props.onClose,
    onSent: props.onSent,
  });

  const asr = () => rexClient.fleet()?.asr;
  const paneAsrActive = () => {
    const a = asr();
    return !!a && a.targetKey === props.paneKey();
  };
  const asrRecording = () => !!(paneAsrActive() && asr()?.recording);
  const asrBusy = () => !!(paneAsrActive() && asr()?.busy);
  const fontSpec = createMemo(() => getFontPreset(rexClient.fleet()?.fontPreset));
  const inputSlot = () => (fontSpec().large ? SLOT.base : SLOT.sm);

  const [desiredSchema, setDesiredSchema] = createSignal<"pinyin_simp" | "double_pinyin">(
    (rexClient.fleet()?.ime.schema as "pinyin_simp" | "double_pinyin" | undefined) ?? "pinyin_simp",
  );
  const currentSchema = () => desiredSchema();
  let nextResumeSchema: "pinyin_simp" | "double_pinyin" = "pinyin_simp";
  createEffect(() => {
    const replied = ctrl.imeReply()?.schema;
    if (replied === "pinyin_simp" || replied === "double_pinyin") {
      setDesiredSchema(replied);
    }
  });

  const draftLayout = createMemo(() =>
    layoutDraftWithCursor(ctrl.draft(), ctrl.cursor(), inputSlot(), DRAFT_TEXT_MAX_W),
  );

  const hasAuxRow = () =>
    asrRecording() ||
    asrBusy() ||
    Boolean(paneAsrActive() && asr()?.error) ||
    (ctrl.imeMode() && ctrl.rimeRaw().length > 0);

  const maxVisRows = createMemo(() => {
    const total = draftLayout().lines.length;
    if (total <= 2) return 2;
    if (total === 3) return 3;
    return hasAuxRow() ? 3 : 4;
  });

  const [scrollRow, setScrollRow] = createSignal(0);

  createEffect(() => {
    const layout = draftLayout();
    const vis = maxVisRows();
    const maxTop = Math.max(0, layout.lines.length - vis);
    let top = scrollRow();
    if (layout.cursorRow < top) top = layout.cursorRow;
    else if (layout.cursorRow >= top + vis) top = layout.cursorRow - vis + 1;
    top = Math.max(0, Math.min(maxTop, top));
    if (top !== scrollRow()) setScrollRow(top);
  });

  const cycleInputMethod = () => {
    const pendingRaw = ctrl.getRimeRawNow();
    if (!ctrl.imeMode()) {
      ctrl.setImeMode(true);
      if (desiredSchema() !== nextResumeSchema) {
        setDesiredSchema(nextResumeSchema);
        ctrl.enqueuePreviewCompose({ raw: "", toggleSchema: true });
      }
      toast(nextResumeSchema === "double_pinyin" ? "输入法: 双拼" : "输入法: 全拼", "ok");
      return;
    }
    if (desiredSchema() === "pinyin_simp") {
      nextResumeSchema = "double_pinyin";
      ctrl.setImeMode(false);
      ctrl.invalidatePreviewIme();
      if (pendingRaw.length > 0) {
        ctrl.setRimeRaw("");
        ctrl.setImeReply(null);
        ctrl.insertText(pendingRaw);
      }
      toast("输入法: EN 英文", "ok");
      return;
    }
    setDesiredSchema("pinyin_simp");
    nextResumeSchema = "pinyin_simp";
    ctrl.enqueuePreviewCompose({ raw: pendingRaw, toggleSchema: true });
    toast("输入法: 全拼", "ok");
  };

  useKey(
    createComposerKeyHandler({
      ctrl,
      paneKey: props.paneKey,
      asrRecording,
      asrBusy,
      draftLayout,
      inputSlot,
      cycleInputMethod,
      onScrollContext: props.onScrollContext,
    }),
  );

  const schemaLabel = () => (currentSchema() === "double_pinyin" ? "双拼" : "全拼");
  const asrProviderTag = () => {
    const p = asr()?.provider;
    if (p === "doubao_free" || p === "doubao") return "豆包";
    if (p === "plugin") return "插件";
    return "语音";
  };

  const rowStep = () => (fontSpec().large ? 19 : 17);
  const boxH = () => maxVisRows() * rowStep() + 4;
  const drawerH = () => 22 + boxH() + (hasAuxRow() ? 20 : 0);
  const drawerY = () => 170 - drawerH();

  createEffect(() => {
    props.onHeightChange?.(drawerH());
  });
  onCleanup(() => {
    props.onHeightChange?.(0);
  });

  const micBars = [0, 1, 2, 3, 4, 5, 6, 7] as const;
  const litMicBars = () =>
    Math.round(Math.max(0, Math.min(1, paneAsrActive() ? (asr()?.level ?? 0) : 0)) * micBars.length);

  const visibleDraftLines = createMemo(() => {
    const top = scrollRow();
    return draftLayout().lines.slice(top, top + maxVisRows());
  });

  const headerHint = createMemo(() => {
    if (rexClient.isUnconfirmedSend(props.paneKey())) return "未确认(^U清 ^E回)";
    if (ctrl.sending()) return "发送中...";
    if (ctrl.imeMode() && ctrl.rimeRaw()) {
      return ellipsize(ctrl.imeReply()?.preedit || ctrl.rimeRaw(), SLOT.xsBold, 190);
    }
    const layout = draftLayout();
    if (layout.lines.length > 1) {
      return `行${layout.cursorRow + 1}/${layout.lines.length}·${layout.totalChars}字  Fn+方向移光标`;
    }
    return "⏎发送  Tab中/英  Alt+V语音";
  });

  const candidateLine = createMemo(() => {
    const rep = ctrl.imeReply();
    if (!rep || rep.candidates.length === 0) return "";
    const parts = rep.candidates.slice(0, 5).map((c, idx) => `${idx + 1}.${c}`);
    const prefix = rep.page > 0 ? "< " : "";
    const suffix = rep.hasMore ? " >" : "";
    return `${prefix}${parts.join(" ")}${suffix}`;
  });

  return (
    <View
      ref={n => slideFrom(n, "translateY", 12, MOTION.focus)}
      class="absolute rounded-sm border"
      style={{
        insetL: 2,
        insetT: drawerY(),
        width: 316,
        height: drawerH(),
        bgColor: THEME.modal,
        borderColor: asrRecording() ? THEME.rose : THEME.amber,
      }}
    >
      {/* Top 18px Header Strip */}
      <View class="absolute left-0 top-0 w-[314]" style={{ height: 18, bgColor: THEME.panel }}>
        <View
          class="absolute rounded-sm"
          style={{
            insetL: 4,
            insetT: 2,
            width: ctrl.imeMode() ? 50 : 28,
            height: 14,
            bgColor: ctrl.imeMode() ? THEME.amber : THEME.cyan,
          }}
        >
          <Text
            class="absolute left-0 top-0 text-xs font-bold leading-[14] text-center"
            style={{ width: ctrl.imeMode() ? 50 : 28, textColor: THEME.darkInk }}
          >
            {ctrl.imeMode() ? `拼·${schemaLabel()}` : "EN"}
          </Text>
        </View>

        <Show
          when={asrRecording() || asrBusy()}
          fallback={
            <Text
              class="absolute text-xs leading-[17]"
              style={{
                insetL: ctrl.imeMode() ? 58 : 36,
                insetT: 1,
                textColor: rexClient.isUnconfirmedSend(props.paneKey()) ? THEME.rose : THEME.muted,
              }}
            >
              {ellipsize(headerHint(), SLOT.xs, ctrl.imeMode() ? 196 : 218)}
            </Text>
          }
        >
          <Text
            class="absolute text-xs font-bold leading-[17]"
            style={{
              insetL: ctrl.imeMode() ? 58 : 36,
              insetT: 1,
              textColor: asrRecording() ? THEME.rose : THEME.amber,
            }}
          >
            {asrRecording() ? `● ${asrProviderTag()}聆听 (⏎完成)` : "○ 正在识别收尾..."}
          </Text>
        </Show>

        <Text class="absolute text-xs leading-[17] text-right" style={{ insetL: 256, insetT: 1, width: 52, textColor: THEME.dim }}>
          {asrRecording() ? "Esc取消" : "Esc收起"}
        </Text>
      </View>

      {/* Auto-Expanding Multi-Line Draft Editor (`2..4` lines + exact cursor bar + scrollbar) */}
      <View
        class="absolute border overflow-hidden"
        style={{
          insetL: 4,
          insetT: 19,
          width: 306,
          height: boxH(),
          bgColor: THEME.bg,
          borderColor: THEME.border,
        }}
      >
        <Show when={draftLayout().totalChars === 0}>
          <Text
            class={fontSpec().large ? "absolute text-base leading-[20]" : "absolute text-sm leading-[18]"}
            style={{ insetL: 8, insetT: 2, textColor: THEME.dim }}
          >
            {ctrl.imeMode() ? "输入拼音，1-5或空格上屏..." : "输入内容，Fn+FXZC移动光标..."}
          </Text>
        </Show>

        <For each={visibleDraftLines()}>
          {(ln, idx) => (
            <Text
              class={fontSpec().large ? "absolute text-base leading-[19]" : "absolute text-sm leading-[17]"}
              style={{ insetL: 5, insetT: 2 + idx() * rowStep(), textColor: THEME.text }}
            >
              {ln.text}
            </Text>
          )}
        </For>

        {/* Non-reflowing 2px live cursor bar */}
        <Show when={ctrl.caretOn() && draftLayout().cursorRow >= scrollRow() && draftLayout().cursorRow < scrollRow() + maxVisRows()}>
          <View
            class="absolute w-[2]"
            style={{
              insetL: 5 + draftLayout().cursorX,
              insetT: 3 + (draftLayout().cursorRow - scrollRow()) * rowStep(),
              height: rowStep() - 3,
              bgColor: ctrl.imeMode() ? THEME.amber : THEME.cyan,
            }}
          />
        </Show>

        {/* Scrollbar when draft exceeds visible rows */}
        <Show when={draftLayout().lines.length > maxVisRows()}>
          <View class="absolute w-[2]" style={{ insetL: 301, insetT: 2, height: boxH() - 6, bgColor: THEME.line }} />
          <View
            class="absolute w-[2]"
            style={{
              insetL: 301,
              insetT:
                2 +
                Math.round(
                  (scrollRow() / Math.max(1, draftLayout().lines.length - maxVisRows())) *
                    Math.max(4, boxH() - 16),
                ),
              height: Math.max(
                8,
                Math.round((maxVisRows() / Math.max(1, draftLayout().lines.length)) * (boxH() - 6)),
              ),
              bgColor: THEME.amber,
            }}
          />
        </Show>
      </View>

      {/* Aux Row (20px): 8-bar mic meter + live streaming words OR crisp Pinyin candidates */}
      <Show when={asrRecording() || asrBusy() || Boolean(paneAsrActive() && asr()?.error)}>
        <View class="absolute" style={{ insetL: 4, insetT: 20 + boxH(), width: 306, height: 19 }}>
          <Show when={asrRecording() || asrBusy()}>
            <View class="absolute" style={{ insetL: 2, insetT: 5, width: 56, height: 9 }}>
              <Index each={micBars}>
                {bar => {
                  const i = bar();
                  const on = () => i < litMicBars();
                  const col = () => (i >= 6 ? THEME.rose : i >= 4 ? THEME.amber : THEME.cyan);
                  return (
                    <View
                      class="absolute top-0"
                      style={{ insetL: i * 7, width: 5, height: 9, bgColor: on() ? col() : THEME.line }}
                    />
                  );
                }}
              </Index>
            </View>
          </Show>
          <Text
            class="absolute text-sm leading-[18]"
            style={{
              insetL: asrRecording() || asrBusy() ? 64 : 4,
              insetT: 0,
              textColor: asr()?.error ? THEME.rose : THEME.amber,
            }}
          >
            {ellipsize(
              (paneAsrActive() ? asr()?.error || asr()?.partial : "") || "请说话，按回车完成...",
              SLOT.sm,
              asrRecording() || asrBusy() ? 240 : 298,
            )}
          </Text>
        </View>
      </Show>

      <Show
        when={
          !asrRecording() &&
          !asrBusy() &&
          !(paneAsrActive() && asr()?.error) &&
          ctrl.imeMode() &&
          ctrl.rimeRaw().length > 0
        }
      >
        <View class="absolute" style={{ insetL: 4, insetT: 20 + boxH(), width: 306, height: 20 }}>
          <Text class="absolute text-sm leading-[19]" style={{ insetL: 2, insetT: 0, textColor: THEME.amber }}>
            {ellipsize(candidateLine() || `${ctrl.rimeRaw()} (无候选)`, SLOT.sm, 300)}
          </Text>
        </View>
      </Show>
    </View>
  );
}
