// Rex Zero pure-black 320x170 application shell, cross-scene shortcuts, and MRU Switcher.

import { Show, createSignal, onCleanup, type JSX } from "solid-js";
import { View } from "@pocketjs/framework/components";
import { GLOBAL_SCOPE, activeInputScope, onKeyIn } from "@pocketjs/framework/compact/primitives";
import {
  isAltKey,
  isCtrlKey,
  isCtrlTab,
  registerNavHandlers,
  rexClient,
} from "./client.ts";
import { RexFrame, isHelpOpen, toast, useScenes } from "./frame.tsx";
import { createInboxScene } from "./scenes/inbox.tsx";
import { QuickSwitchOverlay } from "./scenes/quick_switch.tsx";
import { createSettingsPairScene } from "./scenes/settings_pair.tsx";
import { createWorkspaceScene } from "./scenes/workspace.tsx";
import { THEME } from "./theme.ts";

export function RexApp(): JSX.Element {
  rexClient.start();

  const [topKind, setTopKind] = createSignal<"inbox" | "workspace" | "settings">("inbox");

  const openPane = (key: string) => {
    if (!key) return;
    rexClient.setQuickSwitchOpen(false);
    rexClient.setActivePaneKey(key);
    const scenes = useScenes();
    if (topKind() === "workspace" && scenes.depth() > 1) {
      return;
    }
    const ws = createWorkspaceScene();
    if (topKind() === "settings" && scenes.depth() > 1) {
      setTopKind("workspace");
      scenes.replace(ws);
    } else {
      setTopKind("workspace");
      scenes.push(ws);
    }
  };

  const openSettings = (initialTab: 0 | 1 = 0) => {
    rexClient.setQuickSwitchOpen(false);
    const scenes = useScenes();
    const scene = createSettingsPairScene(initialTab);
    if (topKind() === "settings" && scenes.depth() > 1) {
      scenes.replace(scene);
    } else {
      setTopKind("settings");
      scenes.push(scene);
    }
  };

  const jumpToNextPending = (): boolean => {
    const f = rexClient.fleet();
    if (!f) {
      toast("暂无待处理对话", "dim");
      return false;
    }
    const curKey = rexClient.activePaneKey();
    let target = f.attention.nextTargetKey;
    if (!target || target === curKey) {
      const alt = f.panes.find(
        p => p.key !== curKey && (p.status === "blocked" || p.status === "error" || p.status === "unseen_done"),
      );
      if (alt) target = alt.key;
    }
    if (target) {
      openPane(target);
      toast("已切至待处理对话", "ok");
      return true;
    }
    toast("暂无待处理对话", "dim");
    return false;
  };

  registerNavHandlers(openPane, openSettings, jumpToNextPending);

  onCleanup(
    onKeyIn(GLOBAL_SCOPE, event => {
      const scope = activeInputScope();
      if (scope === "modal" || scope === "help" || isHelpOpen()) return;
      if (event.kind !== "key" || !event.pressed) return;

      if (isAltKey(event.key, "n") || isCtrlKey(event.key, "n")) {
        jumpToNextPending();
        return true;
      }

      if (isCtrlTab(event.key) || (event.key === "`" && !rexClient.isTyping())) {
        if (!rexClient.quickSwitchOpen()) {
          rexClient.setQuickSwitchOpen(true);
          return true;
        }
      }
      return;
    }),
  );

  const rootScene = createInboxScene(() => setTopKind("inbox"));

  return (
    <View class="absolute left-0 top-0 w-[320] h-[170]" style={{ bgColor: THEME.bg }}>
      <RexFrame
        root={rootScene}
        altBlack={() => ((rexClient.fleet()?.fontPreset ?? 0) & 1) === 1}
        exit={{
          title: "退出 Rex Zero",
          text: "确定退出 Rex Zero 并返回桌面吗？",
          action: "退出",
          run: () => rexClient.quitApp(),
        }}
      />
      <Show when={rexClient.quickSwitchOpen()}>
        <QuickSwitchOverlay
          onSelect={key => openPane(key)}
          onClose={() => rexClient.setQuickSwitchOpen(false)}
        />
      </Show>
    </View>
  );
}
