// Pure-black high-contrast palette & global font scaling presets for CardputerZero 320x170 RGB565.

import { SLOT, type Slot } from "@pocketjs/framework/compact/primitives";

export const THEME = {
  /** Pure black primary background (#000000 -> RGB565 0x0000). */
  bg: "#000000",
  /** Alternate pure-black RGB565 0x0000 value (#010101) to force full-screen redraw on crisp toggle. */
  bgAlt: "#010101",
  /** Subtle dark panel surface. */
  panel: "#0b0e13",
  /** Elevated modal / drawer surface. */
  modal: "#0d1117",
  /** Selected row / card highlight fill. */
  sel: "#161f2b",
  /** Hairline divider. */
  line: "#1b222c",
  /** Standard border. */
  border: "#303845",
  /** Bright active border. */
  borderBright: "#4a5568",
  /** Pure white primary ink. */
  text: "#ffffff",
  /** Crisp secondary ink. */
  muted: "#b8c2cf",
  /** Muted metadata ink. */
  dim: "#768292",
  /** Subtle faint ink. */
  faint: "#505a68",
  /** Primary focus / user prompt / blocked alert amber. */
  amber: "#ffc857",
  /** Tool call / unread done / Tailscale live cyan. */
  cyan: "#47d7ff",
  /** Error / recording / destructive rose. */
  rose: "#ff7b9c",
  /** Running / healthy green. */
  green: "#62e2a0",
  /** Dark ink over amber/cyan pills. */
  darkInk: "#000000",
} as const;

export type ReaderViewMode = "chat" | "raw";

export interface FontPresetSpec {
  id: 0 | 1 | 2;
  label: string;
  shortLabel: string;
  large: boolean;
  compact: boolean;
  crisp: boolean;
  slot: Slot;
  textClass: "text-xs" | "text-sm" | "text-base";
  leadingClass: "leading-[15]" | "leading-[18]" | "leading-[20]";
  lineH: number;
}

export const FONT_PRESETS: readonly FontPresetSpec[] = [
  {
    id: 0,
    label: "大字 16px",
    shortLabel: "大字16",
    large: true,
    compact: false,
    crisp: true,
    slot: SLOT.base,
    textClass: "text-base",
    leadingClass: "leading-[20]",
    lineH: 20,
  },
  {
    id: 1,
    label: "标准 14px",
    shortLabel: "标准14",
    large: false,
    compact: false,
    crisp: true,
    slot: SLOT.sm,
    textClass: "text-sm",
    leadingClass: "leading-[18]",
    lineH: 18,
  },
  {
    id: 2,
    label: "紧凑 12px",
    shortLabel: "紧凑12",
    large: false,
    compact: true,
    crisp: true,
    slot: SLOT.xs,
    textClass: "text-xs",
    leadingClass: "leading-[15]",
    lineH: 15,
  },
] as const;

export function getFontPreset(preset: number | null | undefined): FontPresetSpec {
  if (preset === 1) return FONT_PRESETS[1]!;
  if (preset === 2 || preset === 3) return FONT_PRESETS[2]!;
  return FONT_PRESETS[0]!;
}
