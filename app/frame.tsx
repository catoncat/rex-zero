// Pure-black 320x170 full-screen scene frame, confirm dialog, hotkey help modal, and crisp toast.
// Replaces CompactApp's purple 18px+16px bars so scenes own all 320x170 pixels.

import {
  For,
  Show,
  createContext,
  createMemo,
  createSignal,
  onCleanup,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js";
import { after } from "@pocketjs/framework/clock";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import {
  GLOBAL_SCOPE,
  MOTION,
  SLOT,
  arrive,
  ellipsize,
  installCompactInput,
  measure,
  onKeyIn,
  onNavIn,
  setActiveScope,
  slideIn,
  slideOut,
  type NavHandler,
  type Tone,
  wrap,
} from "@pocketjs/framework/compact/primitives";
import { registerToastHandler, toast } from "./notify.ts";
import { THEME } from "./theme.ts";

export { toast };

export interface SceneDef {
  title: string;
  render: () => JSX.Element;
}

export interface Scenes {
  push(scene: SceneDef): void;
  pop(): boolean;
  replace(scene: SceneDef): void;
  popToRoot(): void;
  depth(): number;
}

export interface ConfirmOptions {
  title: string;
  text: string;
  action: string;
  danger?: boolean;
}

export interface HelpRow {
  keys: string;
  desc: string;
}

interface Entry {
  id: number;
  def: SceneDef;
  leaving: Accessor<boolean>;
  setLeaving: (v: boolean) => void;
}

interface ModalState {
  title: string;
  text: string;
  action: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

interface ToastState {
  text: string;
  tone: Tone;
  id: number;
}

interface HelpState {
  title: string;
  rows: readonly HelpRow[];
}

interface FrameCtx {
  scenes: Scenes;
  topId: Accessor<number>;
  modal: Accessor<ModalState | null>;
  setModal: (m: ModalState | null) => void;
  help: Accessor<HelpState | null>;
  setHelp: (h: HelpState | null) => void;
  toast: Accessor<ToastState | null>;
  setToast: (t: ToastState | null) => void;
}

const SceneContext = createContext<Entry | null>(null);
let currentFrame: FrameCtx | null = null;
let nextEntryId = 1;
let nextToastId = 0;

function getFrame(): FrameCtx {
  if (!currentFrame) throw new Error("RexFrame is not mounted");
  return currentFrame;
}

function makeEntry(def: SceneDef): Entry {
  const [leaving, setLeaving] = createSignal(false);
  return { id: nextEntryId++, def, leaving, setLeaving };
}

export function useScenes(): Scenes {
  return getFrame().scenes;
}

export function useSceneActive(): Accessor<boolean> {
  const entry = useContext(SceneContext);
  const f = getFrame();
  return createMemo(() => (entry ? f.topId() === entry.id : true) && f.modal() === null && f.help() === null);
}

function scopeOf(): number | string {
  return useContext(SceneContext)?.id ?? GLOBAL_SCOPE;
}

export function useNav(handler: NavHandler): void {
  onCleanup(onNavIn(scopeOf(), handler));
}

export function useKey(handler: Parameters<typeof onKeyIn>[1]): void {
  onCleanup(onKeyIn(scopeOf(), handler));
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
  const f = getFrame();
  return new Promise(resolve => {
    f.setModal({
      title: options.title,
      text: options.text,
      action: options.action,
      danger: options.danger ?? false,
      resolve,
    });
  });
}

export function openHelp(title: string, rows: readonly HelpRow[]): void {
  getFrame().setHelp({ title, rows });
}

export function closeHelp(): void {
  currentFrame?.setHelp(null);
}

export function isHelpOpen(): boolean {
  return Boolean(currentFrame?.help());
}

export interface RexFrameProps {
  root: SceneDef;
  altBlack?: () => boolean;
  exit?: { title: string; text: string; action: string; run: () => void };
}

export function RexFrame(props: RexFrameProps): JSX.Element {
  installCompactInput();
  const [entries, setEntries] = createSignal<Entry[]>([makeEntry(props.root)]);
  const [modal, setModal] = createSignal<ModalState | null>(null);
  const [help, setHelp] = createSignal<HelpState | null>(null);
  const [toastVal, setToast] = createSignal<ToastState | null>(null);

  const staying = createMemo(() => entries().filter(e => !e.leaving()));
  const topId = createMemo(() => staying()[staying().length - 1]?.id ?? 0);

  const retire = (leaving: Entry[]) => {
    if (leaving.length === 0) return;
    for (const e of leaving) e.setLeaving(true);
    after(MOTION.scene / 1000, () => setEntries(list => list.filter(e => !leaving.includes(e))));
  };

  const scenes: Scenes = {
    push: scene => setEntries(list => [...list, makeEntry(scene)]),
    pop: () => {
      const cur = staying();
      if (cur.length <= 1) return false;
      retire([cur[cur.length - 1]!]);
      return true;
    },
    replace: scene => {
      const cur = staying();
      retire(cur.slice(-1));
      setEntries(list => [...list, makeEntry(scene)]);
    },
    popToRoot: () => retire(staying().slice(1)),
    depth: () => staying().length,
  };

  currentFrame = { scenes, topId, modal, setModal, help, setHelp, toast: toastVal, setToast };
  registerToastHandler((text, tone) => {
    const id = ++nextToastId;
    setToast({ text, tone, id });
    after(1.15, () => {
      if (toastVal()?.id === id) setToast(null);
    });
  });
  onCleanup(() => {
    registerToastHandler(null);
    if (currentFrame?.scenes === scenes) currentFrame = null;
  });

  createMemo(() => {
    if (modal()) setActiveScope("modal");
    else if (help()) setActiveScope("help");
    else setActiveScope(topId());
  });

  onCleanup(
    onNavIn(GLOBAL_SCOPE, event => {
      if (modal() || help()) return;
      if (event.key === "home") {
        scenes.popToRoot();
        return true;
      }
      if (event.key === "back") {
        if (staying().length > 1) {
          scenes.pop();
          return true;
        }
        if (props.exit) {
          const ex = props.exit;
          void confirm({ title: ex.title, text: ex.text, action: ex.action, danger: true }).then(ok => {
            if (ok) ex.run();
          });
          return true;
        }
      }
      return;
    }),
  );

  return (
    <View
      class="absolute left-0 top-0 w-[320] h-[170]"
      style={{ bgColor: props.altBlack?.() ? THEME.bgAlt : THEME.bg }}
    >
      <For each={entries()}>
        {(entry, index) => {
          let nodeRef: NodeMirror | undefined;
          const shown = () => {
            const list = entries();
            return index() >= list.length - 2 || entry.leaving();
          };
          createMemo(() => {
            if (entry.leaving() && nodeRef) slideOut(nodeRef, 320);
          });
          return (
            <SceneContext.Provider value={entry}>
              <View
                ref={n => {
                  nodeRef = n;
                  if (index() > 0) slideIn(n, 320);
                }}
                class="absolute left-0 top-0 w-[320] h-[170] overflow-hidden"
                style={{
                  bgColor: THEME.bg,
                  display: shown() ? undefined : 1,
                }}
              >
                {entry.def.render()}
              </View>
            </SceneContext.Provider>
          );
        }}
      </For>

      <Show when={help()}>
        {h => <HelpModalView state={h()} onClose={() => setHelp(null)} />}
      </Show>

      <Show when={modal()}>
        {m => (
          <ConfirmModalView
            modal={m()}
            onDone={ok => {
              const cur = m();
              setModal(null);
              cur.resolve(ok);
            }}
          />
        )}
      </Show>

      <Show when={toastVal()}>
        {t => <ToastPillView toast={t()} />}
      </Show>
    </View>
  );
}

function ConfirmModalView(props: { modal: ModalState; onDone: (ok: boolean) => void }): JSX.Element {
  const [choice, setChoice] = createSignal<0 | 1>(props.modal.danger ? 0 : 1);
  const bodyLines = createMemo(() => wrap(props.modal.text, SLOT.xs, 232).slice(0, 3));

  onCleanup(
    onKeyIn("modal", ev => {
      if (ev.kind !== "key" || !ev.pressed) return true;
      const k = ev.key;
      if (k === "Escape" || k === "n" || k === "N") {
        props.onDone(false);
        return true;
      }
      if (k === "y" || k === "Y") {
        props.onDone(true);
        return true;
      }
      if (k === "Enter") {
        props.onDone(choice() === 1);
        return true;
      }
      if (k === "ArrowLeft" || k === "ArrowRight" || k === "Tab" || k === "z" || k === "Z" || k === "c" || k === "C") {
        setChoice(c => (c === 0 ? 1 : 0));
        return true;
      }
      return true;
    }),
  );

  onCleanup(
    onNavIn("modal", ev => {
      if (ev.key === "left" || ev.key === "right" || ev.key === "action") setChoice(c => (c === 0 ? 1 : 0));
      else if (ev.key === "ok") props.onDone(choice() === 1);
      else if (ev.key === "back") props.onDone(false);
      return true;
    }),
  );

  const w = 252;
  const h = () => 56 + bodyLines().length * 16;
  const x = Math.round((320 - w) / 2);
  const y = () => Math.round((170 - h()) / 2);
  const actFill = () => (props.modal.danger ? THEME.rose : THEME.amber);

  return (
    <View class="absolute left-0 top-0 w-[320] h-[170] bg-[#000000cc] z-50">
      <View
        ref={n => arrive(n, 5)}
        class="absolute rounded-md border"
        style={{
          insetL: x,
          insetT: y(),
          width: w,
          height: h(),
          bgColor: THEME.modal,
          borderColor: THEME.borderBright,
        }}
      >
        <Text class="absolute text-xs font-bold leading-[16]" style={{ insetL: 10, insetT: 7, textColor: THEME.amber }}>
          {ellipsize(props.modal.title, SLOT.xsBold, w - 20)}
        </Text>
        <For each={bodyLines()}>
          {(ln, i) => (
            <Text class="absolute text-xs leading-[15]" style={{ insetL: 10, insetT: 26 + i() * 16, textColor: THEME.text }}>
              {ln}
            </Text>
          )}
        </For>
        <View
          class="absolute rounded-sm border"
          style={{
            insetL: 10,
            insetT: h() - 26,
            width: 110,
            height: 20,
            bgColor: choice() === 0 ? THEME.sel : THEME.panel,
            borderColor: choice() === 0 ? THEME.amber : THEME.border,
          }}
        >
          <Text
            class="absolute left-0 top-0 text-xs font-bold leading-[18] text-center"
            style={{ width: 108, textColor: choice() === 0 ? THEME.amber : THEME.muted }}
          >
            取消
          </Text>
        </View>
        <View
          class="absolute rounded-sm border"
          style={{
            insetL: w - 122,
            insetT: h() - 26,
            width: 110,
            height: 20,
            bgColor: choice() === 1 ? actFill() : THEME.panel,
            borderColor: choice() === 1 ? actFill() : THEME.border,
          }}
        >
          <Text
            class="absolute left-0 top-0 text-xs font-bold leading-[18] text-center"
            style={{ width: 108, textColor: choice() === 1 ? THEME.darkInk : THEME.muted }}
          >
            {props.modal.action}
          </Text>
        </View>
      </View>
    </View>
  );
}

function HelpModalView(props: { state: HelpState; onClose: () => void }): JSX.Element {
  onCleanup(
    onKeyIn("help", ev => {
      if (ev.kind !== "key" || !ev.pressed) return true;
      props.onClose();
      return true;
    }),
  );
  onCleanup(
    onNavIn("help", () => {
      props.onClose();
      return true;
    }),
  );

  const rows = () => props.state.rows.slice(0, 7);
  const w = 304;
  const rowH = 18;
  const h = () => 26 + rows().length * rowH + 4;
  const x = 8;
  const y = () => Math.max(4, Math.round((170 - h()) / 2));

  return (
    <View class="absolute left-0 top-0 w-[320] h-[170] bg-[#000000d8] z-50">
      <View
        ref={n => arrive(n, 4)}
        class="absolute rounded-md border"
        style={{ insetL: x, insetT: y(), width: w, height: h(), bgColor: THEME.modal, borderColor: THEME.amber }}
      >
        <Text class="absolute text-xs font-bold leading-[16]" style={{ insetL: 8, insetT: 4, textColor: THEME.amber }}>
          {props.state.title}
        </Text>
        <Text
          class="absolute text-xs leading-[16] text-right"
          style={{ insetL: w - 98, insetT: 4, width: 88, textColor: THEME.dim }}
        >
          任意键关闭
        </Text>
        <View class="absolute left-0 h-[1]" style={{ insetT: 22, width: w - 2, bgColor: THEME.line }} />
        <For each={rows()}>
          {(row, i) => (
            <View class="absolute left-0" style={{ insetT: 25 + i() * rowH, width: w - 2, height: rowH }}>
              <Text
                class="absolute text-xs font-bold leading-[16]"
                style={{ insetL: 8, insetT: 0, textColor: THEME.cyan }}
              >
                {ellipsize(row.keys, SLOT.xsBold, 96)}
              </Text>
              <Text
                class="absolute text-xs leading-[16]"
                style={{ insetL: 108, insetT: 0, textColor: THEME.text }}
              >
                {ellipsize(row.desc, SLOT.xs, w - 116)}
              </Text>
            </View>
          )}
        </For>
      </View>
    </View>
  );
}

function ToastPillView(props: { toast: ToastState }): JSX.Element {
  const borderCol = () => {
    switch (props.toast.tone) {
      case "warn":
        return THEME.rose;
      case "accent":
        return THEME.amber;
      case "ok":
        return THEME.green;
      default:
        return THEME.borderBright;
    }
  };
  const textCol = () => {
    switch (props.toast.tone) {
      case "warn":
        return THEME.rose;
      case "accent":
        return THEME.amber;
      case "ok":
        return THEME.green;
      default:
        return THEME.text;
    }
  };
  const label = () => ellipsize(props.toast.text, SLOT.xs, 290);
  const w = () => Math.min(308, Math.max(56, Math.ceil(measure(label(), SLOT.xs)) + 16));

  return (
    <View
      class="absolute rounded-sm border z-50"
      style={{
        insetL: 316 - w(),
        insetT: 134,
        width: w(),
        height: 19,
        bgColor: THEME.modal,
        borderColor: borderCol(),
      }}
    >
      <Text
        class="absolute left-0 top-0 text-xs leading-[17] text-center"
        style={{ width: w() - 2, textColor: textCol() }}
      >
        {label()}
      </Text>
    </View>
  );
}
