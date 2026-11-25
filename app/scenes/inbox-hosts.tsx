// Tab 1 sub-view: Focus-Expanding Accordion Columns (`主机 ↔ 窗口 ↔ [窗格]`, 320x150).
// - Col 0 focused: `主机 136px` + `窗口预览 183px` (`窗格` hidden)
// - Col 1 focused (1-pane window, 95%): `主机窄轨 52px` + `窗口宽幅 267px` (`窗格` 0px, Enter opens directly!)
// - Col 1 focused (2+ panes): `主机窄轨 52px` + `窗口 208px` + `窗格提示轨 58px`
// - Col 2 focused (2+ panes): `主机窄轨 48px` + `窗口窄轨 64px` + `窗格宽幅 206px`

import { Index, Show, createEffect, createMemo, createSignal, type Accessor, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { SLOT, createSelection, display, ellipsize } from "@pocketjs/framework/compact/primitives";
import type { FleetSnapshot, HostState, PaneActivityStatus, PaneSummary } from "../types.ts";
import {
  primaryPaneTitle,
  sanitizeDisplayText,
  shortHostLabel,
  shortenPwd,
  statusMeta,
} from "../client.ts";
import { THEME } from "../theme.ts";

export type HostCol0Item =
  | { kind: "host"; host: HostState; shortName: string; paneCount: number }
  | { kind: "add_conn"; label: string; badge: string };

export interface WindowGroupItem {
  id: string;
  label: string;
  worstStatus: PaneActivityStatus;
  panes: PaneSummary[];
}

export type Col1Item =
  | { kind: "window"; group: WindowGroupItem }
  | { kind: "host_action"; action: "reconnect" | "new_session"; label: string }
  | { kind: "conn_entry"; entryIdx: 0 | 1 | 2 | 3; label: string; right: string };

export function hostDotColor(host: HostState): string {
  switch (host.phase) {
    case "live":
      return THEME.cyan;
    case "connecting":
    case "reconnecting":
      return THEME.amber;
    case "failed":
      return THEME.rose;
    default:
      return THEME.dim;
  }
}

function hostKindShort(host: HostState): string {
  if (host.kind === "local") return "本机";
  if (host.kind === "tailnet") return "TS";
  if (host.kind === "ssh") return "SSH";
  return "TCP";
}

export function buildCol0Items(f: FleetSnapshot | null | undefined): HostCol0Item[] {
  const hosts = f?.hosts ?? [];
  const panes = f?.panes ?? [];
  const items: HostCol0Item[] = hosts.map(host => ({
    kind: "host",
    host,
    shortName: shortHostLabel(host.label, host.endpoint, host.id),
    paneCount: panes.filter(p => p.hostId === host.id).length,
  }));
  const ts = f?.tailnet;
  const badge = ts?.backendState === "Running" ? "TS" : f?.pair.active ? "PIN" : "+";
  items.push({ kind: "add_conn", label: "+添加连接", badge });
  return items;
}

export function buildWindowGroups(hostId: string, panes: readonly PaneSummary[]): WindowGroupItem[] {
  const hostPanes = panes.filter(p => p.hostId === hostId);
  const byWin = new Map<string, PaneSummary[]>();
  for (const p of hostPanes) {
    const wk = `${p.sessionId}|${p.windowId || p.blockId}`;
    const arr = byWin.get(wk);
    if (arr) arr.push(p);
    else byWin.set(wk, [p]);
  }
  const groups: WindowGroupItem[] = [];
  for (const [id, list] of byWin) {
    let worst: PaneActivityStatus = "idle";
    for (const p of list) {
      if (statusMeta(p.status).priority < statusMeta(worst).priority) {
        worst = p.status;
      }
    }
    const first = list[0]!;
    groups.push({
      id,
      label: primaryPaneTitle(first),
      worstStatus: worst,
      panes: list,
    });
  }
  groups.sort((a, b) => statusMeta(a.worstStatus).priority - statusMeta(b.worstStatus).priority);
  return groups;
}

export interface HostsBrowserController {
  col: Accessor<0 | 1 | 2>;
  setCol: (c: 0 | 1 | 2) => void;
  moveCol: (delta: -1 | 1) => void;
  moveRow: (delta: -1 | 1) => void;
  selectedHost: () => HostState | null;
  selectedPane: () => PaneSummary | null;
  selectedCol0: () => HostCol0Item | null;
  selectedCol1: () => Col1Item | null;
}

export function createHostsBrowser(fleet: Accessor<FleetSnapshot | null>) {
  const [col, setCol] = createSignal<0 | 1 | 2>(0);
  const col0Items = createMemo(() => buildCol0Items(fleet()));
  const sel0 = createSelection(() => col0Items().length, 0);

  const selectedCol0 = () => col0Items()[sel0.index()] ?? null;
  const selectedHost = () => {
    const c0 = selectedCol0();
    return c0?.kind === "host" ? c0.host : null;
  };

  const col1Items = createMemo<Col1Item[]>(() => {
    const c0 = selectedCol0();
    const f = fleet();
    if (!c0) return [];
    if (c0.kind === "add_conn") {
      const ts = f?.tailnet;
      const tsRight = ts?.backendState === "Running" ? `${ts.peers.length}台在线` : ts?.enabled ? "连接中" : "去开启";
      const pairRight = f?.pair.active ? `PIN:${f.pair.pin}` : "扫码导入";
      return [
        { kind: "conn_entry", entryIdx: 0, label: "Tailscale 组网节点直连", right: tsRight },
        { kind: "conn_entry", entryIdx: 1, label: "SSH 连接 (user@host)", right: "手输" },
        { kind: "conn_entry", entryIdx: 2, label: "局域网 TCP / HTTPS 直连", right: "手输" },
        { kind: "conn_entry", entryIdx: 3, label: "5分钟手机扫码批量导入", right: pairRight },
      ];
    }
    const groups = buildWindowGroups(c0.host.id, f?.panes ?? []);
    if (groups.length > 0) {
      return groups.map(group => ({ kind: "window" as const, group }));
    }
    if (c0.host.phase !== "live") {
      return [{ kind: "host_action", action: "reconnect", label: "回车重连该主机" }];
    }
    return [{ kind: "host_action", action: "new_session", label: "回车在此主机新建终端" }];
  });

  const sel1 = createSelection(() => col1Items().length, 0);
  let prevHostKey = "";
  createEffect(() => {
    const c0 = selectedCol0();
    const key = c0?.kind === "host" ? c0.host.id : "add_conn";
    if (key !== prevHostKey) {
      prevHostKey = key;
      sel1.set(0);
    }
  });

  const selectedCol1 = () => col1Items()[sel1.index()] ?? null;

  const col2Items = createMemo<PaneSummary[]>(() => {
    const c1 = selectedCol1();
    return c1?.kind === "window" ? c1.group.panes : [];
  });

  const sel2 = createSelection(() => col2Items().length, 0);
  let prevWinKey = "";
  createEffect(() => {
    const c1 = selectedCol1();
    const wk = c1?.kind === "window" ? c1.group.id : "";
    if (wk !== prevWinKey) {
      prevWinKey = wk;
      sel2.set(0);
    }
    if (col() === 2 && col2Items().length <= 1) {
      setCol(1);
    }
  });

  const moveCol = (delta: -1 | 1) => {
    const cur = col();
    if (delta < 0) {
      if (cur > 0) setCol((cur - 1) as 0 | 1);
      return;
    }
    if (cur === 0 && col1Items().length > 0) setCol(1);
    else if (cur === 1 && col2Items().length > 1) setCol(2);
  };

  const moveRow = (delta: -1 | 1) => {
    const cur = col();
    if (cur === 0) sel0.move(delta);
    else if (cur === 1) sel1.move(delta);
    else sel2.move(delta);
  };

  const selectedPane = (): PaneSummary | null => {
    if (col() === 2) return col2Items()[sel2.index()] ?? null;
    const c1 = selectedCol1();
    if (c1?.kind === "window") return c1.group.panes[sel2.index()] ?? c1.group.panes[0] ?? null;
    return null;
  };

  return {
    ctrl: {
      col,
      setCol,
      moveCol,
      moveRow,
      selectedHost,
      selectedPane,
      selectedCol0,
      selectedCol1,
    } satisfies HostsBrowserController,
    col0Items,
    col1Items,
    col2Items,
    sel0,
    sel1,
    sel2,
  };
}

const VISIBLE_ROWS = 5;
const ROW_H = 26;
const HEADER_H = 18;

function windowSlice<T>(items: readonly T[], idx: number): { first: number; slice: T[] } {
  let first = 0;
  if (idx >= VISIBLE_ROWS) first = idx - VISIBLE_ROWS + 1;
  first = Math.max(0, Math.min(first, Math.max(0, items.length - VISIBLE_ROWS)));
  return { first, slice: items.slice(first, first + VISIBLE_ROWS) };
}

export function HostsThreeColView(props: {
  visible: Accessor<boolean>;
  fleet: Accessor<FleetSnapshot | null>;
  browser: ReturnType<typeof createHostsBrowser>;
}): JSX.Element {
  const b = props.browser;
  const activeCol = () => b.ctrl.col();
  const multiPanes = () => b.col2Items().length > 1;

  // Dynamic accordion geometry (always sums to 320px!)
  const col0W = () => (activeCol() === 0 ? 136 : activeCol() === 1 ? 52 : 48);
  const col1X = () => col0W() + 1;
  const col1W = () => {
    if (activeCol() === 0) return 320 - col1X();
    if (activeCol() === 1) return multiPanes() ? 208 : 320 - col1X();
    return 64;
  };
  const showCol2 = () => activeCol() === 2 || (activeCol() === 1 && multiPanes());
  const col2X = () => col1X() + col1W() + 1;
  const col2W = () => (showCol2() ? Math.max(0, 320 - col2X()) : 0);

  const slice0 = createMemo(() => windowSlice(b.col0Items(), b.sel0.index()));
  const slice1 = createMemo(() => windowSlice(b.col1Items(), b.sel1.index()));
  const slice2 = createMemo(() => windowSlice(b.col2Items(), b.sel2.index()));

  const paneLineText = (p: PaneSummary): string => {
    const prog = sanitizeDisplayText(p.program) || "sh";
    const detail = sanitizeDisplayText(p.statusMsg) || shortenPwd(p.pwd) || sanitizeDisplayText(p.title);
    return detail ? `${prog} · ${detail}` : prog;
  };

  return (
    <View
      class="absolute left-0 overflow-hidden"
      style={{
        insetT: 20,
        width: 320,
        height: 150,
        bgColor: THEME.bg,
        display: display(props.visible()),
      }}
    >
      {/* Dynamic Accordion Headers */}
      <View class="absolute left-0 top-0 w-[320]" style={{ height: HEADER_H, bgColor: THEME.panel }}>
        <Text
          class="absolute text-xs font-bold leading-[17]"
          style={{ insetL: 6, insetT: 0, textColor: activeCol() === 0 ? THEME.amber : THEME.dim }}
        >
          {activeCol() === 0 ? "主机 (C展开窗口)" : "主机"}
        </Text>
        <Show when={activeCol() === 0}>
          <View class="absolute h-[2]" style={{ insetL: 4, insetT: 16, width: col0W() - 8, bgColor: THEME.amber }} />
        </Show>

        <Text
          class="absolute text-xs font-bold leading-[17]"
          style={{ insetL: col1X() + 6, insetT: 0, textColor: activeCol() === 1 ? THEME.amber : THEME.dim }}
        >
          {activeCol() === 1
            ? b.ctrl.selectedCol0()?.kind === "add_conn"
              ? "选择连接方式 (⏎进入)"
              : multiPanes()
                ? "窗口 (⏎开 C分屏)"
                : "窗口 (1-5/⏎直达对话)"
            : "窗口"}
        </Text>
        <Show when={activeCol() === 1}>
          <View class="absolute h-[2]" style={{ insetL: col1X() + 4, insetT: 16, width: col1W() - 8, bgColor: THEME.amber }} />
        </Show>

        <Show when={showCol2()}>
          <Text
            class="absolute text-xs font-bold leading-[17]"
            style={{ insetL: col2X() + 5, insetT: 0, textColor: activeCol() === 2 ? THEME.amber : THEME.dim }}
          >
            {activeCol() === 2 ? "分屏窗格 (⏎开)" : `${b.col2Items().length}格›`}
          </Text>
          <Show when={activeCol() === 2}>
            <View class="absolute h-[2]" style={{ insetL: col2X() + 4, insetT: 16, width: col2W() - 8, bgColor: THEME.amber }} />
          </Show>
        </Show>

        <View class="absolute left-0 w-[320] h-[1]" style={{ insetT: 17, bgColor: THEME.line }} />
      </View>

      {/* Accordion Dividers */}
      <View class="absolute w-[1]" style={{ insetL: col0W(), insetT: 0, height: 150, bgColor: THEME.line }} />
      <Show when={showCol2()}>
        <View class="absolute w-[1]" style={{ insetL: col2X() - 1, insetT: 0, height: 150, bgColor: THEME.line }} />
      </Show>

      {/* Column 0: Hosts (136px expanded OR 52px/48px semi-collapsed rail) */}
      <Index each={slice0().slice}>
        {(item, localIdx) => {
          const absIdx = () => slice0().first + localIdx;
          const isSel = () => b.sel0.index() === absIdx();
          const isFocused = () => isSel() && activeCol() === 0;
          const expanded = () => activeCol() === 0;
          return (
            <View
              class="absolute left-0"
              style={{
                insetT: HEADER_H + localIdx * ROW_H,
                width: col0W(),
                height: ROW_H,
                bgColor: isFocused() ? THEME.sel : isSel() ? THEME.panel : THEME.bg,
              }}
            >
              <Show when={isSel()}>
                <View
                  class="absolute left-0 top-0 w-[2]"
                  style={{ height: ROW_H, bgColor: isFocused() ? THEME.amber : THEME.cyan }}
                />
              </Show>
              <Show
                when={item().kind === "host"}
                fallback={
                  <Text
                    class={expanded() ? "absolute text-sm font-bold leading-[26]" : "absolute text-xs font-bold leading-[26]"}
                    style={{ insetL: 6, insetT: 0, textColor: THEME.amber }}
                  >
                    {expanded() ? "+ 添加新连接" : "+连接"}
                  </Text>
                }
              >
                {(() => {
                  const h = () => item() as Extract<HostCol0Item, { kind: "host" }>;
                  const rightTxt = () =>
                    h().host.phase === "live"
                      ? `${hostKindShort(h().host)}·${h().paneCount}`
                      : h().host.phase === "failed"
                        ? "离线"
                        : "连..";
                  return (
                    <>
                      <View
                        class="absolute w-[4] h-[4]"
                        style={{ insetL: 5, insetT: 11, bgColor: hostDotColor(h().host) }}
                      />
                      <Text
                        class={expanded() ? "absolute text-sm leading-[26]" : "absolute text-xs leading-[26]"}
                        style={{ insetL: 12, insetT: 0, textColor: isSel() ? THEME.text : THEME.muted }}
                      >
                        {ellipsize(h().shortName, expanded() ? SLOT.sm : SLOT.xs, expanded() ? 70 : col0W() - 14)}
                      </Text>
                      <Show when={expanded()}>
                        <Text
                          class="absolute text-xs leading-[26] text-right"
                          style={{
                            insetL: col0W() - 50,
                            insetT: 0,
                            width: 46,
                            textColor: h().host.phase === "failed" ? THEME.rose : THEME.dim,
                          }}
                        >
                          {rightTxt()}
                        </Text>
                      </Show>
                    </>
                  );
                })()}
              </Show>
            </View>
          );
        }}
      </Index>

      {/* Column 1: Windows (267px wide when focused on 1-pane window!) */}
      <Index each={slice1().slice}>
        {(item, localIdx) => {
          const absIdx = () => slice1().first + localIdx;
          const isSel = () => b.sel1.index() === absIdx();
          const isFocused = () => isSel() && activeCol() === 1;
          const wide = () => activeCol() === 1;
          const collapsed = () => activeCol() === 2;
          return (
            <View
              class="absolute"
              style={{
                insetL: col1X(),
                insetT: HEADER_H + localIdx * ROW_H,
                width: col1W(),
                height: ROW_H,
                bgColor: isFocused() ? THEME.sel : isSel() ? THEME.panel : THEME.bg,
              }}
            >
              <Show when={isSel()}>
                <View
                  class="absolute left-0 top-0 w-[2]"
                  style={{ height: ROW_H, bgColor: isFocused() ? THEME.amber : THEME.cyan }}
                />
              </Show>
              <Show when={item().kind === "window"}>
                {(() => {
                  const g = () => (item() as Extract<Col1Item, { kind: "window" }>).group;
                  const meta = () => statusMeta(g().worstStatus);
                  const rightBadge = () =>
                    collapsed()
                      ? ""
                      : g().panes.length > 1 && activeCol() === 0
                        ? `${g().panes.length}格`
                        : meta().shortTag;
                  const badgeW = () => (rightBadge() ? 30 : 0);
                  const numPrefix = () => (wide() ? `${localIdx + 1} ` : "");
                  return (
                    <>
                      <View
                        class="absolute w-[4] h-[4]"
                        style={{ insetL: 5, insetT: 11, bgColor: meta().color }}
                      />
                      <Text
                        class={collapsed() ? "absolute text-xs leading-[26]" : "absolute text-sm leading-[26]"}
                        style={{ insetL: 13, insetT: 0, textColor: isSel() ? THEME.text : THEME.muted }}
                      >
                        {ellipsize(
                          `${numPrefix()}${g().label}`,
                          collapsed() ? SLOT.xs : SLOT.sm,
                          col1W() - 18 - badgeW(),
                        )}
                      </Text>
                      <Show when={rightBadge()}>
                        <Text
                          class="absolute text-xs font-bold leading-[26] text-right"
                          style={{ insetL: col1W() - 34, insetT: 0, width: 30, textColor: meta().color }}
                        >
                          {rightBadge()}
                        </Text>
                      </Show>
                    </>
                  );
                })()}
              </Show>
              <Show when={item().kind === "host_action"}>
                <Text
                  class="absolute text-sm font-bold leading-[26]"
                  style={{ insetL: 8, insetT: 0, textColor: THEME.amber }}
                >
                  {ellipsize((item() as Extract<Col1Item, { kind: "host_action" }>).label, SLOT.smBold, col1W() - 14)}
                </Text>
              </Show>
              <Show when={item().kind === "conn_entry"}>
                {(() => {
                  const ce = () => item() as Extract<Col1Item, { kind: "conn_entry" }>;
                  return (
                    <>
                      <Text
                        class="absolute text-sm leading-[26]"
                        style={{ insetL: 8, insetT: 0, textColor: isSel() ? THEME.text : THEME.muted }}
                      >
                        {ellipsize(ce().label, SLOT.sm, col1W() - (wide() ? 70 : 14))}
                      </Text>
                      <Show when={wide()}>
                        <Text
                          class="absolute text-xs font-bold leading-[26] text-right"
                          style={{ insetL: col1W() - 62, insetT: 0, width: 56, textColor: THEME.cyan }}
                        >
                          {ellipsize(ce().right, SLOT.xsBold, 56)}
                        </Text>
                      </Show>
                    </>
                  );
                })()}
              </Show>
            </View>
          );
        }}
      </Index>

      {/* Column 2: Split Panes (only shown when multiPanes or activeCol === 2) */}
      <Show when={showCol2()}>
        <Index each={slice2().slice}>
          {(pane, localIdx) => {
            const absIdx = () => slice2().first + localIdx;
            const isSel = () => b.sel2.index() === absIdx();
            const isFocused = () => isSel() && activeCol() === 2;
            const expanded2 = () => activeCol() === 2;
            return (
              <View
                class="absolute"
                style={{
                  insetL: col2X(),
                  insetT: HEADER_H + localIdx * ROW_H,
                  width: col2W(),
                  height: ROW_H,
                  bgColor: isFocused() ? THEME.sel : isSel() ? THEME.panel : THEME.bg,
                }}
              >
                <Show when={isSel()}>
                  <View
                    class="absolute left-0 top-0 w-[2]"
                    style={{ height: ROW_H, bgColor: isFocused() ? THEME.amber : THEME.borderBright }}
                  />
                </Show>
                <View
                  class="absolute w-[4] h-[4]"
                  style={{ insetL: 5, insetT: 11, bgColor: statusMeta(pane().status).color }}
                />
                <Text
                  class={expanded2() ? "absolute text-sm leading-[26]" : "absolute text-xs leading-[26]"}
                  style={{ insetL: 12, insetT: 0, textColor: isSel() ? THEME.text : THEME.muted }}
                >
                  {ellipsize(
                    expanded2() ? `${localIdx + 1} ${paneLineText(pane())}` : sanitizeDisplayText(pane().program) || "sh",
                    expanded2() ? SLOT.sm : SLOT.xs,
                    col2W() - 16,
                  )}
                </Text>
              </View>
            );
          }}
        </Index>
      </Show>
    </View>
  );
}
