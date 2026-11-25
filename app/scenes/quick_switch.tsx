// Pure-black MRU Conversation Switcher (`Tab` / `` ` ``) with instant 2nd-Tab Alt-Tab swap
// & `/` keyword search, plus 4x2 Quick-Key Grid Modal (`k` / `^K`).

import { For, Index, Show, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import {
  GLOBAL_SCOPE,
  SLOT,
  arrive,
  createSelection,
  ellipsize,
  measure,
  onKeyIn,
  onNavIn,
} from "@pocketjs/framework/compact/primitives";
import type { PaneSummary } from "../types.ts";
import {
  isAltKey,
  isCtrlKey,
  isCtrlTab,
  isPrintableChar,
  primaryPaneTitle,
  rexClient,
  shortHostLabel,
  sortPanesByPriority,
  statusMeta,
} from "../client.ts";
import { THEME } from "../theme.ts";

// ---- MRU Conversation Switcher (`Tab` / `^Tab` / `` ` ``) -------------------

export interface QuickSwitchOverlayProps {
  onSelect: (key: string) => void;
  onClose: () => void;
}

export function QuickSwitchOverlay(props: QuickSwitchOverlayProps): JSX.Element {
  const [searching, setSearching] = createSignal(false);
  const [filter, setFilter] = createSignal("");
  const [movedManually, setMovedManually] = createSignal(false);

  const orderedAll = createMemo<PaneSummary[]>(() => {
    const panes = rexClient.fleet()?.panes ?? [];
    const byKey = new Map(panes.map(p => [p.key, p]));
    const picked: PaneSummary[] = [];
    const used = new Set<string>();

    const activeKey = rexClient.activePaneKey();
    const mru = rexClient.mruKeys();
    // Put previous MRU pane at index 0 so pressing `Tab` again immediately swaps (Alt-Tab)!
    const orderedMru =
      activeKey && mru[0] === activeKey && mru.length > 1
        ? [...mru.slice(1), mru[0]!]
        : mru;

    for (const k of orderedMru) {
      const p = byKey.get(k);
      if (p && !used.has(p.key)) {
        used.add(p.key);
        picked.push(p);
      }
    }
    for (const p of sortPanesByPriority(panes)) {
      if (!used.has(p.key)) {
        used.add(p.key);
        picked.push(p);
      }
    }
    return picked;
  });

  const candidates = createMemo<PaneSummary[]>(() => {
    const q = filter().trim().toLowerCase();
    const list = orderedAll();
    const matched = q
      ? list.filter(p => {
          const alias = shortHostLabel(p.hostLabel, undefined, p.hostId);
          return `${p.windowLabel} ${p.title} ${alias} ${p.program}`.toLowerCase().includes(q);
        })
      : list;
    return matched.slice(0, 5);
  });

  const sel = createSelection(() => candidates().length, 0);

  const pick = (index: number) => {
    const item = candidates()[index];
    if (!item) {
      props.onClose();
      return;
    }
    props.onSelect(item.key);
    props.onClose();
  };

  onCleanup(
    onKeyIn(GLOBAL_SCOPE, event => {
      if (searching()) {
        if (event.kind === "commit") {
          setFilter(q => (q + event.text).slice(0, 24));
          return true;
        }
        if (event.kind !== "key" || !event.pressed) return true;
        const k = event.key;
        if (k === "Escape") {
          if (filter().length > 0) setFilter("");
          setSearching(false);
          return true;
        }
        if (k === "Enter") {
          setSearching(false);
          if (candidates().length === 1) pick(0);
          return true;
        }
        if (k === "Backspace") {
          setFilter(q => [...q].slice(0, -1).join(""));
          return true;
        }
        if (isPrintableChar(k)) {
          setFilter(q => (q + k).slice(0, 24));
          return true;
        }
        return true;
      }

      if (event.kind !== "key" || !event.pressed) return true;
      const k = event.key;
      if (isAltKey(k, "n") || isCtrlKey(k, "n")) {
        props.onClose();
        return false;
      }
      if (k === "Escape" || k === "`" || k === "Backspace") {
        props.onClose();
        return true;
      }
      // Pressing `Tab` immediately jumps to index 0 (previous MRU conversation = instant Alt-Tab!)
      // unless the user already navigated with F/X, in which case Tab cycles!
      if (k === "Tab" || isCtrlTab(k)) {
        const len = candidates().length;
        if (len === 0) {
          props.onClose();
          return true;
        }
        if (!movedManually() && rexClient.activePaneKey() && candidates()[0]?.key !== rexClient.activePaneKey()) {
          pick(0);
          return true;
        }
        setMovedManually(true);
        sel.set((sel.index() + 1) % len);
        return true;
      }
      if (k === "/") {
        setSearching(true);
        return true;
      }
      if (k === "Enter") {
        pick(sel.index());
        return true;
      }
      if (k === "ArrowUp" || k === "f" || k === "F") {
        setMovedManually(true);
        sel.move(-1);
        return true;
      }
      if (k === "ArrowDown" || k === "x" || k === "X") {
        setMovedManually(true);
        sel.move(1);
        return true;
      }
      if (k.length === 1 && k >= "1" && k <= "5") {
        const idx = k.charCodeAt(0) - 49;
        if (idx < candidates().length) pick(idx);
        return true;
      }
      return true;
    }),
  );

  onCleanup(
    onNavIn(GLOBAL_SCOPE, event => {
      if (searching()) return true;
      if (event.key === "up") {
        setMovedManually(true);
        sel.move(-1);
      } else if (event.key === "down") {
        setMovedManually(true);
        sel.move(1);
      } else if (event.key === "ok") {
        pick(sel.index());
      } else if (event.key === "back") {
        props.onClose();
      }
      return true;
    }),
  );

  const cardW = 300;
  const rowH = 22;
  const cardH = () => 24 + Math.max(1, candidates().length) * rowH + 6;
  const cardX = 10;
  const cardY = () => Math.max(6, Math.round((170 - cardH()) / 2));

  return (
    <View class="absolute left-0 top-0 w-[320] h-[170] bg-[#000000d8] z-50">
      <View
        ref={n => arrive(n, 5)}
        class="absolute rounded-md border"
        style={{
          insetL: cardX,
          insetT: cardY(),
          width: cardW,
          height: cardH(),
          bgColor: THEME.modal,
          borderColor: THEME.amber,
        }}
      >
        <Text class="absolute text-xs font-bold leading-[18]" style={{ insetL: 8, insetT: 3, textColor: THEME.amber }}>
          {searching() ? `搜: ${filter() || "..."}` : filter() ? `切换 (筛:${filter()})` : "切换对话"}
        </Text>
        <Text
          class="absolute text-xs leading-[18] text-right"
          style={{ insetL: cardW - 148, insetT: 3, width: 140, textColor: THEME.dim }}
        >
          {searching() ? "⏎确定 Esc清空" : "Tab闪切 1-5/⏎ /搜"}
        </Text>
        <View class="absolute left-0 h-[1]" style={{ insetT: 22, width: cardW - 2, bgColor: THEME.line }} />

        <Show
          when={candidates().length > 0}
          fallback={
            <Text class="absolute text-xs leading-[20]" style={{ insetL: 10, insetT: 26, textColor: THEME.dim }}>
              无匹配对话
            </Text>
          }
        >
          <For each={candidates()}>
            {(pane, i) => {
              const focused = () => sel.index() === i();
              const meta = () => statusMeta(pane.status);
              const isCurrent = () => pane.key === rexClient.activePaneKey();
              const hostAlias = () => shortHostLabel(pane.hostLabel, undefined, pane.hostId);
              const rightTag = () => (isCurrent() ? "当前" : hostAlias());
              const rightW = () => Math.min(54, Math.ceil(measure(rightTag(), SLOT.xs)));
              return (
                <View
                  class="absolute rounded-sm"
                  style={{
                    insetL: 4,
                    insetT: 25 + i() * rowH,
                    width: cardW - 10,
                    height: rowH - 1,
                    bgColor: focused() ? THEME.sel : THEME.modal,
                  }}
                >
                  <Show when={focused()}>
                    <View class="absolute left-0 top-0 w-[2]" style={{ height: rowH - 1, bgColor: THEME.amber }} />
                  </Show>
                  <Text
                    class="absolute text-xs leading-[20]"
                    style={{ insetL: 6, insetT: 0, textColor: focused() ? THEME.amber : THEME.dim }}
                  >
                    {String(i() + 1)}
                  </Text>
                  <View class="absolute w-[4] h-[4]" style={{ insetL: 16, insetT: 8, bgColor: meta().color }} />
                  <Text
                    class="absolute text-sm leading-[20]"
                    style={{ insetL: 24, insetT: 0, textColor: THEME.text }}
                  >
                    {ellipsize(primaryPaneTitle(pane), SLOT.sm, cardW - 44 - rightW())}
                  </Text>
                  <Text
                    class="absolute text-xs leading-[20] text-right"
                    style={{
                      insetL: cardW - 16 - rightW(),
                      insetT: 0,
                      width: rightW(),
                      textColor: isCurrent() ? THEME.green : THEME.dim,
                    }}
                  >
                    {rightTag()}
                  </Text>
                </View>
              );
            }}
          </For>
        </Show>
      </View>
    </View>
  );
}

// ---- 4x2 Quick-Key Grid Modal (`k` / `^K` in Detail) -----------------------

export interface QuickKeyItem {
  id: string;
  keyHint: string;
  label: string;
  danger?: boolean;
  accent?: boolean;
  run: () => void;
}

export interface QuickKeyModalProps {
  items: readonly QuickKeyItem[];
  onClose: () => void;
}

export function QuickKeyModal(props: QuickKeyModalProps): JSX.Element {
  const gridItems = () => props.items.slice(0, 8);
  const closePaneItem = () => props.items[8] ?? null;
  const sel = createSelection(() => gridItems().length, 0);

  const execute = (item: QuickKeyItem | undefined | null) => {
    props.onClose();
    if (item) item.run();
  };

  onCleanup(
    onKeyIn(GLOBAL_SCOPE, event => {
      if (event.kind !== "key" || !event.pressed) return true;
      const k = event.key;
      if (k === "Escape" || k === "Backspace" || k === "k" || k === "K" || isCtrlKey(k, "k")) {
        props.onClose();
        return true;
      }
      if (k === "Enter") {
        execute(gridItems()[sel.index()]);
        return true;
      }
      if (k === "ArrowLeft" || k === "z" || k === "Z") {
        sel.move(-1);
        return true;
      }
      if (k === "ArrowRight" || k === "c" || k === "C") {
        sel.move(1);
        return true;
      }
      if (k === "ArrowUp" || k === "f" || k === "F") {
        const next = sel.index() - 4;
        if (next >= 0) sel.set(next);
        return true;
      }
      if (k === "ArrowDown" || k === "x" || k === "X") {
        const next = sel.index() + 4;
        if (next < gridItems().length) sel.set(next);
        return true;
      }
      if (k.length === 1 && k >= "1" && k <= "9") {
        const idx = k.charCodeAt(0) - 49;
        if (idx < props.items.length) execute(props.items[idx]);
        return true;
      }
      if (k === "y" || k === "Y") {
        const yItem = props.items.find(it => it.id === "yes");
        if (yItem) execute(yItem);
        return true;
      }
      if (k === "n" || k === "N") {
        const nItem = props.items.find(it => it.id === "no");
        if (nItem) execute(nItem);
        return true;
      }
      return true;
    }),
  );

  onCleanup(
    onNavIn(GLOBAL_SCOPE, event => {
      if (event.key === "left") sel.move(-1);
      else if (event.key === "right") sel.move(1);
      else if (event.key === "up") {
        if (sel.index() >= 4) sel.set(sel.index() - 4);
      } else if (event.key === "down") {
        if (sel.index() + 4 < gridItems().length) sel.set(sel.index() + 4);
      } else if (event.key === "ok") {
        execute(gridItems()[sel.index()]);
      } else if (event.key === "back") {
        props.onClose();
      }
      return true;
    }),
  );

  const cardW = 304;
  const cardH = 108;
  const cardX = 8;
  const cardY = 31;
  const cellW = 71;
  const cellH = 26;
  const gapX = 4;
  const gapY = 5;

  return (
    <View class="absolute left-0 top-0 w-[320] h-[170] bg-[#000000d8] z-40">
      <View
        ref={n => arrive(n, 4)}
        class="absolute rounded-md border"
        style={{ insetL: cardX, insetT: cardY, width: cardW, height: cardH, bgColor: THEME.modal, borderColor: THEME.cyan }}
      >
        <Text class="absolute text-xs font-bold leading-[16]" style={{ insetL: 8, insetT: 4, textColor: THEME.cyan }}>
          快捷按键面板 (k)
        </Text>
        <Text
          class="absolute text-xs leading-[16] text-right"
          style={{ insetL: cardW - 148, insetT: 4, width: 140, textColor: THEME.dim }}
        >
          1-8直发  ⏎执  Esc关
        </Text>
        <View class="absolute left-0 h-[1]" style={{ insetT: 21, width: cardW - 2, bgColor: THEME.line }} />

        <Index each={gridItems()}>
          {(item, idx) => {
            const focused = () => sel.index() === idx;
            const row = Math.floor(idx / 4);
            const col = idx % 4;
            return (
              <View
                class="absolute rounded-sm border"
                style={{
                  insetL: 6 + col * (cellW + gapX),
                  insetT: 26 + row * (cellH + gapY),
                  width: cellW,
                  height: cellH,
                  bgColor: focused() ? THEME.sel : THEME.panel,
                  borderColor: focused()
                    ? THEME.amber
                    : item().accent
                      ? THEME.cyan
                      : THEME.border,
                }}
              >
                <Text
                  class="absolute left-0 top-0 text-xs font-bold leading-[24] text-center"
                  style={{
                    width: cellW - 2,
                    textColor: focused()
                      ? THEME.amber
                      : item().danger
                        ? THEME.rose
                        : THEME.text,
                  }}
                >
                  {`${idx + 1}:${item().label}`}
                </Text>
              </View>
            );
          }}
        </Index>

        <Show when={closePaneItem()}>
          {closeIt => (
            <Text
              class="absolute left-0 text-xs leading-[15] text-center"
              style={{ insetT: 88, width: cardW - 2, textColor: THEME.rose }}
            >
              {`按 9 ${closeIt().label}`}
            </Text>
          )}
        </Show>
      </View>
    </View>
  );
}
