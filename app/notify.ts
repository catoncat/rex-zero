// Pure TypeScript toast notification emitter shared between `client/` and `frame.tsx`
// without pulling any JSX or unused `compact` component trees into `client/` or unit tests.

import type { Tone } from "@pocketjs/framework/compact/primitives";

type ToastHandler = (text: string, tone: Tone) => void;

let activeToastHandler: ToastHandler | null = null;

export function registerToastHandler(fn: ToastHandler | null): void {
  activeToastHandler = fn;
}

export function toast(text: string, tone: Tone = "ink"): void {
  activeToastHandler?.(text, tone);
}
