// Pure-black visual sub-views for Scene 2 (`Workspace`):
// Top 20px Header, Unified Crisp Body (`阅读` & `终端`), Bottom 14px HUD Bar, Approval Banner, and Safe Settings Modal (`s`).

import { For, Index, Show, type Accessor, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { SLOT, ellipsize, measure } from "@pocketjs/framework/compact/primitives";
import { sanitizeDisplayText } from "../client.ts";
import { THEME, type FontPresetSpec, type ReaderViewMode } from "../theme.ts";
import type { ApprovalLayout, VisualLine } from "./reader-layout.ts";

export const WS_TOP_H = 20;
export const WS_HUD_H = 14;
export const WS_FULL_BODY_H = 150;
export const WS_BODY_WITH_HUD_H = 136;
export const VT_COLS = 50;

export interface WorkspaceHeaderInfo {
  dotColor: string;
  fullTitle: string;
  pageText: string;
  pageColor: string;
  liveBadge: string;
  liveColor: string;
}

export interface WorkspaceSettingRow {
  id: string;
  label: string;
  value: string;
  valueColor: string;
}

export function WorkspaceTopBar(props: { info: Accessor<WorkspaceHeaderInfo> }): JSX.Element {
  const info = props.info;
  const pageW = () => Math.ceil(measure(info().pageText, SLOT.xsBold)) + 4;
  const liveW = () => (info().liveBadge ? Math.ceil(measure(info().liveBadge, SLOT.xsBold)) + 8 : 0);
  const titleMaxW = () => Math.max(96, 314 - 14 - pageW() - liveW() - 6);

  return (
    <View class="absolute left-0 top-0 w-[320]" style={{ height: WS_TOP_H, bgColor: THEME.bg }}>
      <View class="absolute w-[4] h-[4]" style={{ insetL: 6, insetT: 8, bgColor: info().dotColor }} />
      <Text class="absolute text-xs font-bold leading-[18]" style={{ insetL: 14, insetT: 1, textColor: THEME.text }}>
        {ellipsize(info().fullTitle, SLOT.xsBold, titleMaxW())}
      </Text>

      <Show when={info().liveBadge}>
        <Text
          class="absolute text-xs font-bold leading-[18] text-right"
          style={{
            insetL: 314 - pageW() - liveW(),
            insetT: 1,
            width: liveW() - 4,
            textColor: info().liveColor,
          }}
        >
          {info().liveBadge}
        </Text>
      </Show>

      <Text
        class="absolute text-xs font-bold leading-[18] text-right"
        style={{
          insetL: 314 - pageW(),
          insetT: 1,
          width: pageW(),
          textColor: info().pageColor,
        }}
      >
        {info().pageText}
      </Text>

      <View class="absolute left-0 w-[320] h-[1]" style={{ insetT: 19, bgColor: THEME.line }} />
    </View>
  );
}

export function WorkspaceBottomHud(props: {
  mode: Accessor<ReaderViewMode>;
  scrolledUp: Accessor<boolean>;
}): JSX.Element {
  const hint = () => {
    if (props.mode() === "raw") {
      return props.scrolledUp()
        ? "↑回看 Fn+L/M翻页 打字回底 Alt+M阅读 Alt+⌫返回"
        : "直输 Alt+M阅读 Alt+P/V中音 Fn+L/M滚屏 Alt+⌫返回";
    }
    return props.scrolledUp()
      ? "F/X滚屏 Z/C翻页 b回底 ⏎回复 m终端 s设置 ⌫返回"
      : "F/X滚屏 ⏎回复 p拼音 v语音 m切终端 s设置 ⌫返回";
  };

  return (
    <View class="absolute left-0 w-[320]" style={{ insetT: 170 - WS_HUD_H, height: WS_HUD_H, bgColor: THEME.panel }}>
      <View class="absolute left-0 top-0 w-[320] h-[1]" style={{ bgColor: THEME.line }} />
      <Text class="absolute text-xs leading-[13]" style={{ insetL: 4, insetT: 1, textColor: THEME.dim }}>
        {ellipsize(hint(), SLOT.xs, 312)}
      </Text>
    </View>
  );
}

export function WorkspaceDocBody(props: {
  paneLoaded: Accessor<boolean>;
  mode: Accessor<ReaderViewMode>;
  fontSpec: Accessor<FontPresetSpec>;
  bodyH: Accessor<number>;
  hudReserve: Accessor<number>;
  composerReserve: Accessor<number>;
  shownLines: Accessor<VisualLine[]>;
  totalLines: Accessor<number>;
  visibleLineCount: Accessor<number>;
  scrollOffset: Accessor<number>;
  maxScroll: Accessor<number>;
  approvalLayout: Accessor<ApprovalLayout | null>;
}): JSX.Element {
  const lineH = () => props.fontSpec().lineH;
  const lineTextClass = () => {
    const spec = props.fontSpec();
    if (spec.large) return "absolute text-base leading-[20]";
    if (spec.compact) return "absolute text-xs leading-[15]";
    return "absolute text-sm leading-[18]";
  };

  return (
    <>
      <View class="absolute left-0 overflow-hidden" style={{ insetT: WS_TOP_H, width: 320, height: props.bodyH() }}>
        <Show
          when={props.totalLines() > 0}
          fallback={
            <Text class="absolute text-sm leading-[18]" style={{ insetL: 8, insetT: 12, textColor: THEME.dim }}>
              {props.paneLoaded()
                ? props.mode() === "raw"
                  ? "终端已就绪 (直接敲键盘输命令，Alt+M 切回阅读)"
                  : "暂无对话消息 (按 ⏎ 回复，m 切终端)"
                : "正在加载对话内容..."}
            </Text>
          }
        >
          <Index each={props.shownLines()}>
            {(line, idx) => (
              <View class="absolute left-0" style={{ insetT: idx * lineH(), width: 315, height: lineH() }}>
                <Show when={line().barColor}>
                  {c => (
                    <View
                      class="absolute w-[2]"
                      style={{ insetL: 3, insetT: 2, height: lineH() - 3, bgColor: c() }}
                    />
                  )}
                </Show>
                <Show when={line().text.length > 0}>
                  <Text
                    class={lineTextClass()}
                    style={{ insetL: 8, insetT: 0, textColor: line().color }}
                  >
                    {line().text}
                  </Text>
                </Show>
              </View>
            )}
          </Index>
        </Show>

        <Show when={props.maxScroll() > 0}>
          <View class="absolute w-[2]" style={{ insetL: 317, insetT: 2, height: props.bodyH() - 4, bgColor: THEME.line }} />
          <View
            class="absolute w-[2]"
            style={{
              insetL: 317,
              insetT:
                2 +
                Math.round(
                  (props.scrollOffset() / Math.max(1, props.maxScroll())) * Math.max(4, props.bodyH() - 16),
                ),
              height: Math.max(
                10,
                Math.round((props.visibleLineCount() / Math.max(1, props.totalLines())) * (props.bodyH() - 4)),
              ),
              bgColor: props.scrollOffset() < props.maxScroll() ? THEME.cyan : THEME.dim,
            }}
          />
        </Show>
      </View>

      <Show when={props.approvalLayout()}>
        {layout => {
          const h = () => layout().height;
          const y = () => 170 - props.composerReserve() - props.hudReserve() - h() - 1;
          return (
            <View
              class="absolute rounded-sm border"
              style={{
                insetL: 3,
                insetT: y(),
                width: 314,
                height: h(),
                bgColor: THEME.modal,
                borderColor: THEME.amber,
              }}
            >
              <View class="absolute left-0 top-0 w-[2]" style={{ height: h() - 2, bgColor: THEME.amber }} />
              <Text class="absolute text-xs font-bold leading-[15]" style={{ insetL: 7, insetT: 2, textColor: THEME.amber }}>
                {ellipsize(`⚠ ${sanitizeDisplayText(layout().card.title)}`, SLOT.xsBold, 300)}
              </Text>
              <Show when={layout().detailLine}>
                <Text class="absolute text-xs leading-[14]" style={{ insetL: 7, insetT: 17, textColor: THEME.muted }}>
                  {ellipsize(layout().detailLine, SLOT.xs, 300)}
                </Text>
              </Show>
              <For each={layout().optionBoxes}>
                {box => (
                  <View
                    class="absolute rounded-sm border"
                    style={{
                      insetL: box.x,
                      insetT: h() - layout().optionsAreaH - 3 + box.y,
                      width: box.w,
                      height: 16,
                      bgColor: box.primary ? THEME.amber : THEME.panel,
                      borderColor: box.primary ? THEME.amber : THEME.border,
                    }}
                  >
                    <Text
                      class="absolute left-0 top-0 text-xs font-bold leading-[15] text-center"
                      style={{ width: box.w - 2, textColor: box.primary ? THEME.darkInk : THEME.text }}
                    >
                      {ellipsize(box.label, SLOT.xsBold, box.w - 6)}
                    </Text>
                  </View>
                )}
              </For>
            </View>
          );
        }}
      </Show>
    </>
  );
}

export function WorkspaceSettingsModal(props: {
  rows: Accessor<WorkspaceSettingRow[]>;
  selectedIndex: Accessor<number>;
}): JSX.Element {
  return (
    <View
      class="absolute rounded-md border"
      style={{
        insetL: 8,
        insetT: 22,
        width: 304,
        height: 122,
        bgColor: THEME.modal,
        borderColor: THEME.amber,
      }}
    >
      <Text class="absolute text-xs font-bold leading-[16]" style={{ insetL: 8, insetT: 3, textColor: THEME.amber }}>
        对话设置 (s)
      </Text>
      <Text class="absolute text-xs leading-[16] text-right" style={{ insetL: 136, insetT: 3, width: 160, textColor: THEME.dim }}>
        Z/C切换 · k快捷控制 · Esc关闭
      </Text>
      <View class="absolute left-0 w-[302] h-[1]" style={{ insetT: 20, bgColor: THEME.line }} />

      <Index each={props.rows()}>
        {(row, idx) => {
          const sel = () => props.selectedIndex() === idx;
          const valW = () => Math.min(136, Math.ceil(measure(row().value, SLOT.xsBold)) + 4);
          return (
            <View
              class="absolute rounded-sm"
              style={{
                insetL: 4,
                insetT: 23 + idx * 24,
                width: 294,
                height: 22,
                bgColor: sel() ? THEME.sel : THEME.modal,
              }}
            >
              <Show when={sel()}>
                <View class="absolute left-0 top-0 w-[2] h-[22]" style={{ bgColor: THEME.amber }} />
              </Show>
              <Text
                class="absolute text-sm leading-[21]"
                style={{ insetL: 7, insetT: 0, textColor: sel() ? THEME.text : THEME.muted }}
              >
                {ellipsize(row().label, SLOT.sm, 282 - valW())}
              </Text>
              <Text
                class="absolute text-xs font-bold leading-[21] text-right"
                style={{ insetL: 288 - valW(), insetT: 0, width: valW(), textColor: row().valueColor }}
              >
                {row().value}
              </Text>
            </View>
          );
        }}
      </Index>
    </View>
  );
}
