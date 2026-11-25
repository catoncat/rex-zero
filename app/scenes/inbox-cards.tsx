// Pure-black 3-Tab Top Bar (`对话 | 主机 | 设置`) & Globally Scaled Cards View (`标准14` 4-card / `大字16` 3-card).

import { Index, Show, createMemo, type Accessor, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { SLOT, display, ellipsize, measure } from "@pocketjs/framework/compact/primitives";
import type { PaneSummary } from "../types.ts";
import {
  formatRelativeAge,
  primaryPaneTitle,
  rexClient,
  secondaryPaneSubtitle,
  shortHostLabel,
  statusMeta,
} from "../client.ts";
import { THEME, getFontPreset } from "../theme.ts";

export const INBOX_TOP_H = 20;
export const INBOX_BODY_H = 150;

export function visibleCardsForPreset(preset: number | null | undefined): number {
  return getFontPreset(preset).large ? 3 : 4;
}

export interface TopRightSummary {
  urgent: string;
  urgentColor: string;
  meta: string;
}

export function InboxTopBar(props: {
  tab: Accessor<0 | 1 | 2>;
  searching: Accessor<boolean>;
  query: Accessor<string>;
  summary: Accessor<TopRightSummary>;
}): JSX.Element {
  return (
    <Show
      when={!props.searching()}
      fallback={
        <View class="absolute left-0 top-0 w-[320]" style={{ height: INBOX_TOP_H, bgColor: THEME.panel }}>
          <Text class="absolute text-xs font-bold leading-[19]" style={{ insetL: 6, insetT: 0, textColor: THEME.amber }}>
            搜:
          </Text>
          <Text class="absolute text-xs leading-[19]" style={{ insetL: 28, insetT: 0, textColor: THEME.text }}>
            {ellipsize(props.query() || "输入任务名/主机/状态...", SLOT.xs, 224)}
          </Text>
          <Show when={props.query().length > 0}>
            <View
              class="absolute w-[1] h-[12]"
              style={{
                insetL: 29 + Math.min(222, Math.ceil(measure(props.query(), SLOT.xs))),
                insetT: 4,
                bgColor: THEME.amber,
              }}
            />
          </Show>
          <Text class="absolute text-xs leading-[19] text-right" style={{ insetL: 256, insetT: 0, width: 58, textColor: THEME.dim }}>
            ⏎确 Esc清
          </Text>
          <View class="absolute left-0 w-[320] h-[1]" style={{ insetT: 19, bgColor: THEME.amber }} />
        </View>
      }
    >
      <View class="absolute left-0 top-0 w-[320]" style={{ height: INBOX_TOP_H, bgColor: THEME.bg }}>
        <Text
          class="absolute text-xs font-bold leading-[18]"
          style={{ insetL: 6, insetT: 1, textColor: props.tab() === 0 ? THEME.text : THEME.dim }}
        >
          对话
        </Text>
        <Show when={props.tab() === 0}>
          <View class="absolute h-[2]" style={{ insetL: 5, insetT: 18, width: 28, bgColor: THEME.amber }} />
        </Show>

        <Text
          class="absolute text-xs font-bold leading-[18]"
          style={{ insetL: 42, insetT: 1, textColor: props.tab() === 1 ? THEME.text : THEME.dim }}
        >
          主机
        </Text>
        <Show when={props.tab() === 1}>
          <View class="absolute h-[2]" style={{ insetL: 41, insetT: 18, width: 28, bgColor: THEME.amber }} />
        </Show>

        <Text
          class="absolute text-xs font-bold leading-[18]"
          style={{ insetL: 78, insetT: 1, textColor: props.tab() === 2 ? THEME.text : THEME.dim }}
        >
          设置
        </Text>
        <Show when={props.tab() === 2}>
          <View class="absolute h-[2]" style={{ insetL: 77, insetT: 18, width: 28, bgColor: THEME.amber }} />
        </Show>

        {(() => {
          const sum = props.summary;
          const metaW = () => Math.min(144, Math.ceil(measure(sum().meta, SLOT.xs)));
          const urgW = () => (sum().urgent ? Math.ceil(measure(sum().urgent, SLOT.xsBold)) : 0);
          return (
            <>
              <Show when={sum().urgent}>
                <Text
                  class="absolute text-xs font-bold leading-[18] text-right"
                  style={{
                    insetL: Math.max(112, 314 - metaW() - 5 - urgW()),
                    insetT: 1,
                    width: urgW() + 2,
                    textColor: sum().urgentColor,
                  }}
                >
                  {sum().urgent}
                </Text>
              </Show>
              <Text
                class="absolute text-xs leading-[18] text-right"
                style={{ insetL: 314 - metaW(), insetT: 1, width: metaW(), textColor: THEME.muted }}
              >
                {sum().meta}
              </Text>
            </>
          );
        })()}

        <View class="absolute left-0 w-[320] h-[1]" style={{ insetT: 19, bgColor: THEME.line }} />
      </View>
    </Show>
  );
}

export function InboxCardsView(props: {
  visible: Accessor<boolean>;
  query: Accessor<string>;
  totalCount: Accessor<number>;
  paneFirst: Accessor<number>;
  selectedIndex: Accessor<number>;
  visibleCards: Accessor<PaneSummary[]>;
  hostEndpointMap: Accessor<Map<string, string>>;
}): JSX.Element {
  const fontSpec = createMemo(() => getFontPreset(rexClient.fleet()?.fontPreset));
  const isLarge = () => fontSpec().large;
  const isCompact = () => fontSpec().compact;
  const cardCount = () => (isLarge() ? 3 : 4);
  const cardsAreaH = 136;
  const cardStride = () => (isLarge() ? 45 : 34);
  const cardH = () => (isLarge() ? 44 : 33);

  return (
    <View
      class="absolute left-0 overflow-hidden"
      style={{
        insetT: INBOX_TOP_H,
        width: 320,
        height: INBOX_BODY_H,
        bgColor: THEME.bg,
        display: display(props.visible()),
      }}
    >
      <Show
        when={props.totalCount() > 0}
        fallback={
          <View class="absolute left-0 top-0 w-[320]" style={{ height: INBOX_BODY_H }}>
            <Text class="absolute left-0 text-sm leading-[18] text-center" style={{ insetT: 46, width: 320, textColor: THEME.muted }}>
              {props.query() ? "无匹配对话 (按 Esc 清空筛选)" : "暂无活动对话"}
            </Text>
            <Text class="absolute left-0 text-xs leading-[16] text-center" style={{ insetT: 70, width: 320, textColor: THEME.dim }}>
              按 Tab 进入「主机」或「设置」连接新机器
            </Text>
          </View>
        }
      >
        <Index each={props.visibleCards()}>
          {(pane, localIdx) => {
            const absIdx = () => props.paneFirst() + localIdx;
            const selected = () => props.selectedIndex() === absIdx();
            const meta = () => statusMeta(pane().status);
            const title = () => primaryPaneTitle(pane());
            const subtitle = () => secondaryPaneSubtitle(pane(), title());
            const hostShort = () =>
              shortHostLabel(pane().hostLabel, props.hostEndpointMap().get(pane().hostId), pane().hostId);
            const statusTag = () => {
              const st = meta().shortTag;
              if (st) return st;
              return pane().hasDraft || rexClient.getDraft(pane().key).length > 0 ? "稿" : "";
            };
            const statusTagColor = () => (meta().shortTag ? meta().color : THEME.amber);
            const age = () => formatRelativeAge(pane().updatedAtMs, rexClient.nowMs());

            const titleSlot = () => (isLarge() ? SLOT.base : isCompact() ? SLOT.xsBold : SLOT.sm);
            const subSlot = () => (isLarge() ? SLOT.sm : SLOT.xs);
            const hostW = () => Math.min(54, Math.ceil(measure(hostShort(), SLOT.xs)));
            const tagW = () => (statusTag() ? Math.ceil(measure(statusTag(), SLOT.xsBold)) + 2 : 0);
            const tagGap = () => (statusTag() ? 5 : 0);
            const titleMaxW = () => Math.max(112, 306 - 24 - hostW() - tagW() - tagGap() - 6);

            const ageW = () => (age() ? Math.ceil(measure(age(), SLOT.xs)) : 0);
            const subMaxW = () => Math.max(136, 306 - 24 - (ageW() > 0 ? ageW() + 6 : 0));
            const subColor = () => {
              if (pane().status === "blocked") return THEME.amber;
              if (pane().status === "error") return THEME.rose;
              return selected() ? THEME.muted : THEME.dim;
            };

            return (
              <View
                class="absolute rounded-sm"
                style={{
                  insetL: 2,
                  insetT: localIdx * cardStride(),
                  width: 314,
                  height: cardH(),
                  bgColor: selected() ? THEME.sel : THEME.bg,
                  borderWidth: selected() ? 1 : 0,
                  borderColor: selected() ? THEME.borderBright : THEME.bg,
                }}
              >
                <Show
                  when={selected()}
                  fallback={
                    <View class="absolute left-0 h-[1]" style={{ insetT: cardH() - 1, width: 312, bgColor: THEME.line }} />
                  }
                >
                  <View class="absolute left-0 top-0 w-[2]" style={{ height: cardH() - 2, bgColor: THEME.amber }} />
                </Show>

                <Text
                  class="absolute text-xs font-bold leading-[16]"
                  style={{ insetL: 5, insetT: isLarge() ? 4 : 2, textColor: selected() ? THEME.amber : THEME.dim }}
                >
                  {String(localIdx + 1)}
                </Text>
                <View
                  class="absolute w-[4] h-[4]"
                  style={{ insetL: 16, insetT: isLarge() ? 10 : 8, bgColor: meta().color }}
                />
                <Text
                  class={
                    isLarge()
                      ? "absolute text-base leading-[20]"
                      : isCompact()
                        ? "absolute text-xs font-bold leading-[16]"
                        : "absolute text-sm leading-[18]"
                  }
                  style={{ insetL: 24, insetT: isLarge() ? 2 : 1, textColor: THEME.text }}
                >
                  {ellipsize(title(), titleSlot(), titleMaxW())}
                </Text>

                <Show when={statusTag()}>
                  <Text
                    class="absolute text-xs font-bold leading-[16] text-right"
                    style={{
                      insetL: 308 - hostW() - tagGap() - tagW(),
                      insetT: isLarge() ? 4 : 1,
                      width: tagW(),
                      textColor: statusTagColor(),
                    }}
                  >
                    {statusTag()}
                  </Text>
                </Show>
                <Text
                  class="absolute text-xs leading-[16] text-right"
                  style={{
                    insetL: 308 - hostW(),
                    insetT: isLarge() ? 4 : 1,
                    width: hostW(),
                    textColor: selected() ? THEME.muted : THEME.dim,
                  }}
                >
                  {hostShort()}
                </Text>

                <Text
                  class={isLarge() ? "absolute text-sm leading-[18]" : "absolute text-xs leading-[14]"}
                  style={{ insetL: 24, insetT: isLarge() ? 24 : 18, textColor: subColor() }}
                >
                  {ellipsize(subtitle(), subSlot(), subMaxW())}
                </Text>
                <Show when={age()}>
                  <Text
                    class="absolute text-xs leading-[14] text-right"
                    style={{ insetL: 308 - ageW(), insetT: isLarge() ? 25 : 18, width: ageW(), textColor: THEME.faint }}
                  >
                    {age()}
                  </Text>
                </Show>
              </View>
            );
          }}
        </Index>
      </Show>

      <Show when={props.totalCount() > cardCount()}>
        <View class="absolute w-[2]" style={{ insetL: 318, insetT: 2, height: cardsAreaH - 4, bgColor: THEME.line }} />
        <View
          class="absolute w-[2]"
          style={{
            insetL: 318,
            insetT: 2 + Math.round((props.paneFirst() / Math.max(1, props.totalCount())) * (cardsAreaH - 4)),
            height: Math.max(10, Math.round((cardCount() / props.totalCount()) * (cardsAreaH - 4))),
            bgColor: THEME.dim,
          }}
        />
      </Show>

      <View class="absolute left-0 w-[320]" style={{ insetT: cardsAreaH, height: 14, bgColor: THEME.panel }}>
        <View class="absolute left-0 top-0 w-[320] h-[1]" style={{ bgColor: THEME.line }} />
        <Text class="absolute text-xs leading-[13]" style={{ insetL: 4, insetT: 1, textColor: THEME.dim }}>
          {`F/X选卡  ⏎打开  1-${cardCount()}直达  Tab切栏  t字号  s设置`}
        </Text>
      </View>
    </View>
  );
}
