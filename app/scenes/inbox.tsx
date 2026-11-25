// Scene 1 (Root, 320x170 pure black): unified controller & muscle-memory shortcuts
// across 3 top-level tabs: `对话` (Tab 0) | `主机` (Tab 1 Accordion) | `设置` (Tab 2 Settings & Connections).

import { createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { after } from "@pocketjs/framework/clock";
import { View } from "@pocketjs/framework/components";
import { SLOT, createSelection, ellipsize } from "@pocketjs/framework/compact/primitives";
import type { PaneSummary } from "../types.ts";
import {
  isCtrlKey,
  isPrintableChar,
  jumpToNextPending,
  navigateToPane,
  navigateToSettings,
  rexClient,
  shortHostLabel,
  sortPanesByPriority,
} from "../client.ts";
import { openHelp, toast, useKey, useNav, useSceneActive, type HelpRow, type SceneDef } from "../frame.tsx";
import { FONT_PRESETS, THEME, getFontPreset } from "../theme.ts";
import { InboxCardsView, InboxTopBar, visibleCardsForPreset, type TopRightSummary } from "./inbox-cards.tsx";
import { HostsThreeColView, createHostsBrowser } from "./inbox-hosts.tsx";
import { SettingsTabView, createSettingsController } from "./settings-tab.tsx";

const ROOT_TAB0_HELP: readonly HelpRow[] = [
  { keys: "F/X   Z/C", desc: "上下选卡 / 整屏翻页" },
  { keys: "1-4 / ⏎", desc: "一键直开第1-4条 / 打开" },
  { keys: "Tab    s", desc: "切换 对话·主机·设置 / 直达设置" },
  { keys: "/     t", desc: "搜索过滤 / 切换全局字号" },
  { keys: "n     `", desc: "跳待处理对话 / 最近对话快切" },
  { keys: "Esc", desc: "清空过滤 / 退出确认" },
];

const ROOT_TAB1_HELP: readonly HelpRow[] = [
  { keys: "Z/C   ←/→", desc: "折叠/展开 主机 ↔ 窗口 ↔ 窗格" },
  { keys: "F/X   ⏎", desc: "上下选择 / 展开窗口或直开对话" },
  { keys: "1-5", desc: "窗口列一键直开第1-5个窗口" },
  { keys: "n   Space", desc: "所选主机新建会话 / 过滤该机对话" },
  { keys: "BS ×2", desc: "在主机列连按两次移除节点" },
  { keys: "Tab    s", desc: "切换栏目 / 进入设置添加连接" },
];

const ROOT_TAB2_HELP: readonly HelpRow[] = [
  { keys: "F/X   ↑/↓", desc: "上下选择配置或连接方式" },
  { keys: "Z/C   ←/→", desc: "左右切换字号 / 语音 / 视图 / 声音" },
  { keys: "⏎ Enter", desc: "添加连接 / 扫码组网 / 切换选项" },
  { keys: "BS ×2", desc: "选中已存主机时连按两次移除" },
  { keys: "Tab / Esc", desc: "切换栏目 / 返回对话列表" },
];

export function createInboxScene(onBecomeActive?: () => void): SceneDef {
  return {
    title: "Rex Zero",
    render: () => <InboxView onBecomeActive={onBecomeActive} />,
  };
}

function InboxView(props: { onBecomeActive?: () => void }): JSX.Element {
  const active = useSceneActive();
  const [tab, setTab] = createSignal<0 | 1 | 2>(0);
  const [searching, setSearching] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [hostFilter, setHostFilter] = createSignal<{ id: string; label: string } | null>(null);
  const [creatingHost, setCreatingHost] = createSignal<string | null>(null);

  const hostsBrowser = createHostsBrowser(() => rexClient.fleet());
  const settingsCtrl = createSettingsController(() => rexClient.fleet());

  let wasActive = false;
  let removeArmedId: string | null = null;
  let removeTimer: (() => void) | null = null;

  const disarmRemove = () => {
    removeArmedId = null;
    removeTimer?.();
    removeTimer = null;
  };

  onCleanup(disarmRemove);

  createEffect(() => {
    const isActive = active();
    if (isActive && !wasActive) {
      disarmRemove();
      props.onBecomeActive?.();
      rexClient.setActivePaneKey(null);
    }
    if (isActive) {
      rexClient.setIsTyping(searching() || Boolean(settingsCtrl.prompt()));
    }
    wasActive = isActive;
  });

  const hostEndpointMap = createMemo(() => {
    const map = new Map<string, string>();
    for (const h of rexClient.fleet()?.hosts ?? []) map.set(h.id, h.endpoint);
    return map;
  });

  const sortedPanes = createMemo<PaneSummary[]>(() => sortPanesByPriority(rexClient.fleet()?.panes ?? []));

  const filteredPanes = createMemo<PaneSummary[]>(() => {
    const hf = hostFilter();
    const q = query().trim().toLowerCase();
    const epMap = hostEndpointMap();
    let list = sortedPanes();
    if (hf) list = list.filter(p => p.hostId === hf.id);
    if (!q) return list;
    return list.filter(p => {
      const alias = shortHostLabel(p.hostLabel, epMap.get(p.hostId), p.hostId);
      const hay = `${p.windowLabel} ${p.title} ${p.hostLabel} ${alias} ${p.sessionLabel} ${p.program} ${p.statusMsg ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  });

  const visibleCardLimit = createMemo(() => visibleCardsForPreset(rexClient.fleet()?.fontPreset));
  const paneSel = createSelection(() => filteredPanes().length);
  const [paneFirst, setPaneFirst] = createSignal(0);

  createEffect(() => {
    const idx = paneSel.index();
    const total = filteredPanes().length;
    const cap = visibleCardLimit();
    let f = paneFirst();
    if (idx < f) f = idx;
    else if (idx >= f + cap) f = idx - cap + 1;
    f = Math.max(0, Math.min(f, Math.max(0, total - cap)));
    if (f !== paneFirst()) setPaneFirst(f);
  });

  const visibleCards = createMemo(() => filteredPanes().slice(paneFirst(), paneFirst() + visibleCardLimit()));

  const openPaneAt = (idx: number) => {
    const p = filteredPanes()[idx];
    if (p) navigateToPane(p.key);
  };

  const cycleGlobalFont = () => {
    const cur = rexClient.fleet()?.fontPreset ?? 0;
    const next = (cur + 1) % FONT_PRESETS.length;
    void rexClient.dispatchAction({ op: "set_ui_prefs", fontPreset: next }).then(r => {
      if (r.ok) toast(`字号: ${getFontPreset(next).label}`, "ok");
    });
  };

  const reconnectHost = (hostId: string, label: string, endpoint: string) => {
    if (creatingHost()) return;
    setCreatingHost(hostId);
    toast(`正在重连 ${label}...`, "dim");
    void rexClient
      .dispatchAction({ op: "add_host", label, endpoint })
      .then(r => toast(r.ok ? `已重连 ${label}` : (r.error || "重连失败"), r.ok ? "ok" : "warn"))
      .finally(() => setCreatingHost(null));
  };

  const createNewSessionOnHost = (hostId: string, label: string) => {
    if (creatingHost()) return;
    setCreatingHost(hostId);
    toast(`正在 ${label} 新建会话...`, "dim");
    void rexClient
      .dispatchAction({ op: "new_session", hostId })
      .then(r => {
        if (!r.ok) {
          toast(r.error || "新建会话失败", "warn");
          return;
        }
        if (r.createdKey) {
          toast("已新建会话", "ok");
          navigateToPane(r.createdKey);
        } else {
          toast(`已在 ${label} 创建会话`, "ok");
          setTab(0);
        }
      })
      .finally(() => setCreatingHost(null));
  };

  const armOrRemoveHost = (hostId: string, label: string) => {
    if (hostId === "local" || hostId === "cp0") {
      disarmRemove();
      toast("本机节点不可移除", "dim");
      return;
    }
    if (removeArmedId !== hostId) {
      removeArmedId = hostId;
      removeTimer?.();
      removeTimer = after(2, () => {
        removeArmedId = null;
        removeTimer = null;
      });
      toast(`再按一次退格移除 ${label}`, "accent");
      return;
    }
    disarmRemove();
    void rexClient.dispatchAction({ op: "remove_host", hostId }).then(r => {
      toast(r.ok ? `已移除 ${label}` : (r.error || "移除失败"), r.ok ? "ok" : "warn");
    });
  };

  const activateHostBrowserSelection = () => {
    const c0 = hostsBrowser.ctrl.selectedCol0();
    if (!c0) return;

    if (hostsBrowser.ctrl.col() === 0) {
      if (c0.kind === "add_conn") {
        hostsBrowser.ctrl.setCol(1);
        return;
      }
      if (c0.paneCount > 0) {
        hostsBrowser.ctrl.setCol(1);
        return;
      }
      if (c0.host.phase !== "live") reconnectHost(c0.host.id, c0.shortName, c0.host.endpoint);
      else createNewSessionOnHost(c0.host.id, c0.shortName);
      return;
    }

    if (c0.kind === "add_conn") {
      const c1 = hostsBrowser.ctrl.selectedCol1();
      if (c1?.kind === "conn_entry") {
        if (c1.entryIdx === 0) navigateToSettings(0);
        else if (c1.entryIdx === 1) {
          setTab(2);
          settingsCtrl.openInlinePrompt("ssh");
        } else if (c1.entryIdx === 2) {
          setTab(2);
          settingsCtrl.openInlinePrompt("tcp");
        } else {
          navigateToSettings(1);
        }
      } else {
        setTab(2);
      }
      return;
    }

    const pane = hostsBrowser.ctrl.selectedPane();
    if (pane) {
      navigateToPane(pane.key);
      return;
    }
    if (c0.host.phase !== "live") reconnectHost(c0.host.id, c0.shortName, c0.host.endpoint);
    else createNewSessionOnHost(c0.host.id, c0.shortName);
  };

  useKey(event => {
    if (rexClient.quickSwitchOpen()) return;

    // 1. Inline SSH / TCP address prompt in Settings Tab
    const activePrompt = settingsCtrl.prompt();
    if (activePrompt) {
      if (event.kind === "commit") {
        settingsCtrl.setPrompt({ ...activePrompt, text: (activePrompt.text + event.text).slice(0, 96) });
        return true;
      }
      if (event.kind !== "key") return;
      if (!event.pressed) return event.key !== "Shift";
      const k = event.key;
      if (k === "Escape") {
        settingsCtrl.setPrompt(null);
        return true;
      }
      if (k === "Enter") {
        settingsCtrl.submitPrompt();
        return true;
      }
      if (k === "Backspace") {
        settingsCtrl.setPrompt({ ...activePrompt, text: [...activePrompt.text].slice(0, -1).join("") });
        return true;
      }
      if (isCtrlKey(k, "u")) {
        settingsCtrl.setPrompt({ ...activePrompt, text: "" });
        return true;
      }
      if (isPrintableChar(k)) {
        settingsCtrl.setPrompt({ ...activePrompt, text: (activePrompt.text + k).slice(0, 96) });
        return true;
      }
      return true;
    }

    // 2. Keyword search bar in Tab 0
    if (searching()) {
      if (event.kind === "commit") {
        setQuery(q => (q + event.text).slice(0, 32));
        return true;
      }
      if (event.kind !== "key") return;
      if (!event.pressed) return event.key !== "Shift";
      const k = event.key;
      if (isCtrlKey(k, "n") || k === "Control+Tab") return false;
      if (k === "Escape") {
        setSearching(false);
        setQuery("");
        return true;
      }
      if (k === "Enter") {
        setSearching(false);
        return true;
      }
      if (k === "Backspace") {
        setQuery(q => [...q].slice(0, -1).join(""));
        return true;
      }
      if (isCtrlKey(k, "u")) {
        setQuery("");
        return true;
      }
      if (isPrintableChar(k)) {
        setQuery(q => (q + k).slice(0, 32));
        return true;
      }
      return k === "Shift" || k === "Tab" || k.includes("Arrow");
    }

    if (event.kind !== "key" || !event.pressed) return;
    const k = event.key;

    if (isCtrlKey(k, "q")) {
      disarmRemove();
      rexClient.quitApp();
      return true;
    }
    if (k === "?" || k === "h" || k === "H") {
      if (tab() === 0) openHelp("对话列表快捷键", ROOT_TAB0_HELP);
      else if (tab() === 1) openHelp("手风琴主机栏快捷键", ROOT_TAB1_HELP);
      else openHelp("设置与连接中心快捷键", ROOT_TAB2_HELP);
      return true;
    }
    if (k === "g" || k === "G") {
      navigateToSettings(0);
      return true;
    }
    if (k === "s" || k === "S") {
      setTab(t => (t === 2 ? 0 : 2));
      return true;
    }
    if (k === "t" || k === "T") {
      cycleGlobalFont();
      return true;
    }
    if (k === "n" || k === "N") {
      if (tab() === 0) {
        jumpToNextPending();
      } else if (tab() === 1) {
        const host = hostsBrowser.ctrl.selectedHost();
        if (host) {
          const short = shortHostLabel(host.label, host.endpoint, host.id);
          if (host.phase === "live") createNewSessionOnHost(host.id, short);
          else reconnectHost(host.id, short, host.endpoint);
        } else {
          setTab(2);
        }
      }
      return true;
    }

    if (k === "Backspace" || k === "Delete") {
      if (tab() === 1 && hostsBrowser.ctrl.col() === 0) {
        const host = hostsBrowser.ctrl.selectedHost();
        if (host) {
          armOrRemoveHost(host.id, shortHostLabel(host.label, host.endpoint, host.id));
          return true;
        }
      }
      if (tab() === 2) {
        const curItem = settingsCtrl.items()[settingsCtrl.sel.index()];
        if (curItem?.id === "host_row") {
          armOrRemoveHost(curItem.host.id, shortHostLabel(curItem.host.label, curItem.host.endpoint, curItem.host.id));
          return true;
        }
      }
    }
    disarmRemove();

    if (tab() === 0 && k.length === 1 && k >= "1" && k <= "4") {
      const offset = k.charCodeAt(0) - 49;
      if (offset < visibleCards().length) {
        openPaneAt(paneFirst() + offset);
        return true;
      }
    }
    if (tab() === 1 && hostsBrowser.ctrl.col() >= 1 && k.length === 1 && k >= "1" && k <= "5") {
      const offset = k.charCodeAt(0) - 49;
      if (hostsBrowser.ctrl.col() === 1) {
        const items = hostsBrowser.col1Items();
        let first = 0;
        if (hostsBrowser.sel1.index() >= 5) first = hostsBrowser.sel1.index() - 4;
        first = Math.max(0, Math.min(first, Math.max(0, items.length - 5)));
        const target = items[first + offset];
        if (target) {
          hostsBrowser.sel1.set(first + offset);
          activateHostBrowserSelection();
          return true;
        }
      } else {
        const items = hostsBrowser.col2Items();
        let first = 0;
        if (hostsBrowser.sel2.index() >= 5) first = hostsBrowser.sel2.index() - 4;
        first = Math.max(0, Math.min(first, Math.max(0, items.length - 5)));
        const target = items[first + offset];
        if (target) {
          navigateToPane(target.key);
          return true;
        }
      }
    }
    return;
  });

  useNav(event => {
    if (rexClient.quickSwitchOpen() || searching() || settingsCtrl.prompt()) return;
    disarmRemove();

    if (event.key === "action") {
      setTab(t => ((t + 1) % 3) as 0 | 1 | 2);
      return true;
    }
    if (event.key === "search") {
      setTab(0);
      setSearching(true);
      return true;
    }
    if (event.key === "back") {
      if (tab() === 0 && (query().length > 0 || hostFilter() !== null)) {
        setQuery("");
        setHostFilter(null);
        return true;
      }
      if (tab() === 1 && hostsBrowser.ctrl.col() > 0) {
        hostsBrowser.ctrl.moveCol(-1);
        return true;
      }
      if (tab() === 2) {
        setTab(0);
        return true;
      }
      return false;
    }

    if (tab() === 0) {
      const pageCap = visibleCardLimit();
      if (event.key === "up") paneSel.move(-1);
      else if (event.key === "down") paneSel.move(1);
      else if (event.key === "left") paneSel.move(-pageCap);
      else if (event.key === "right" || event.key === "pause") paneSel.move(pageCap);
      else if (event.key === "ok") openPaneAt(paneSel.index());
      else return;
      return true;
    }

    if (tab() === 1) {
      if (event.key === "up") hostsBrowser.ctrl.moveRow(-1);
      else if (event.key === "down") hostsBrowser.ctrl.moveRow(1);
      else if (event.key === "left") hostsBrowser.ctrl.moveCol(-1);
      else if (event.key === "right") hostsBrowser.ctrl.moveCol(1);
      else if (event.key === "ok") activateHostBrowserSelection();
      else if (event.key === "pause") {
        const host = hostsBrowser.ctrl.selectedHost();
        if (host) {
          const short = shortHostLabel(host.label, host.endpoint, host.id);
          setQuery("");
          setHostFilter({ id: host.id, label: short });
          setTab(0);
          toast(`筛选主机: ${short}`, "ok");
        }
      } else {
        return;
      }
      return true;
    }

    // Tab 2: Settings & Connections
    if (event.key === "up") settingsCtrl.sel.move(-1);
    else if (event.key === "down") settingsCtrl.sel.move(1);
    else if (event.key === "left") settingsCtrl.stepItem(-1);
    else if (event.key === "right") settingsCtrl.stepItem(1);
    else if (event.key === "ok" || event.key === "pause") settingsCtrl.stepItem(0);
    else return;
    return true;
  });

  const topRightSummary = createMemo<TopRightSummary>(() => {
    const f = rexClient.fleet();
    if (!f) return { urgent: "", urgentColor: THEME.amber, meta: rexClient.connected() ? "同步中" : "连接中..." };
    const att = f.attention;
    let urgent = "";
    let urgentColor: string = THEME.amber;
    if (att.blockedCount > 0) {
      urgent = `${att.blockedCount}待批`;
      urgentColor = THEME.amber;
    } else if (att.errorCount > 0) {
      urgent = `${att.errorCount}报错`;
      urgentColor = THEME.rose;
    } else if (att.unseenDoneCount > 0) {
      urgent = `${att.unseenDoneCount}新`;
      urgentColor = THEME.cyan;
    }

    const runningCount = f.panes.filter(p => p.status === "running").length;
    const parts: string[] = [];
    const filterLabel = query().trim() || hostFilter()?.label || "";
    if (filterLabel) parts.push(`筛:${ellipsize(filterLabel, SLOT.xs, 40)}`);
    else if (runningCount > 0) parts.push(`${runningCount}*`);
    parts.push(`${f.panes.length}窗`);
    if (att.muted) parts.push("静");
    if (f.tailnet.backendState === "Running") parts.push("TS");
    if (f.batteryPercent != null) parts.push(`${Math.round(f.batteryPercent)}%${f.charging ? "+" : ""}`);
    return { urgent, urgentColor, meta: parts.join(" ") };
  });

  return (
    <View class="absolute left-0 top-0 w-[320] h-[170]" style={{ bgColor: THEME.bg }}>
      <InboxTopBar tab={tab} searching={searching} query={query} summary={topRightSummary} />
      <InboxCardsView
        visible={() => tab() === 0}
        query={query}
        totalCount={() => filteredPanes().length}
        paneFirst={paneFirst}
        selectedIndex={paneSel.index}
        visibleCards={visibleCards}
        hostEndpointMap={hostEndpointMap}
      />
      <HostsThreeColView visible={() => tab() === 1} fleet={() => rexClient.fleet()} browser={hostsBrowser} />
      <SettingsTabView visible={() => tab() === 2} ctrl={settingsCtrl} />
    </View>
  );
}
