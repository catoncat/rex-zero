import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { decodePNG, encodePNG } from "../vendor/pocketjs/tools/png.ts";
import { BUILD, ROOT } from "./paths.ts";

type RGB = readonly [number, number, number];

const BG_BASE: RGB = [0x12, 0x10, 0x1e]; // #12101e deep obsidian/plum
const BG_GLOW: RGB = [0x21, 0x1b, 0x3a]; // subtle center plum lift
const GRID_COLOR: RGB = [0x2a, 0x24, 0x44];
const FRAME_COLOR: RGB = [0x3b, 0x33, 0x5c];
const CYAN_CORE: RGB = [0x38, 0xf2, 0xff]; // glowing electric cyan
const CYAN_GLOW: RGB = [0x06, 0xb6, 0xd4];
const AMBER_CORE: RGB = [0xff, 0xc8, 0x3d]; // glowing warm amber
const AMBER_GLOW: RGB = [0xf5, 0x9e, 0x0b];
const BEACON_CORE: RGB = [0x34, 0xf5, 0x9e]; // fleet status emerald-mint
const BEACON_RING: RGB = [0x10, 0xb9, 0x81];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Signed distance to a line segment from (ax, ay) to (bx, by) in normalized [0,1] coords. */
function sdSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const lenSq = bax * bax + bay * bay;
  const h = lenSq > 0 ? clamp01((pax * bax + pay * bay) / lenSq) : 0;
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  return Math.hypot(dx, dy);
}

/** Signed distance to an axis-aligned box centered at (cx, cy) with half-extents (hx, hy). */
function sdBox(px: number, py: number, cx: number, cy: number, hx: number, hy: number): number {
  const dx = Math.abs(px - cx) - hx;
  const dy = Math.abs(py - cy) - hy;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

function blend(dst: [number, number, number], src: RGB, alpha: number): void {
  const a = clamp01(alpha);
  dst[0] = dst[0] * (1 - a) + src[0] * a;
  dst[1] = dst[1] * (1 - a) + src[1] * a;
  dst[2] = dst[2] * (1 - a) + src[2] * a;
}

function addGlow(dst: [number, number, number], src: RGB, intensity: number): void {
  const a = clamp01(intensity);
  dst[0] = Math.min(255, dst[0] + src[0] * a);
  dst[1] = Math.min(255, dst[1] + src[1] * a);
  dst[2] = Math.min(255, dst[2] + src[2] * a);
}

/**
 * Renders a full-bleed square Rex Zero icon (no rounded corners, no transparency)
 * and returns encoded PNG bytes.
 */
export function drawRexZeroIcon(size: number): Uint8Array {
  if (!Number.isInteger(size) || size < 16) {
    throw new Error(`drawRexZeroIcon: invalid size ${size}`);
  }

  const rgba = new Uint8Array(size * size * 4);
  const aa = 1.25 / size; // ~1.25px antialiasing feather in normalized coords

  // Subtle grid spacing scaled cleanly so lines stay crisp at both 100px and 256px.
  const gridStep = Math.max(6, Math.round(size / 12));
  const scanPeriod = size >= 180 ? 4 : 3;

  for (let y = 0; y < size; y++) {
    const ny = (y + 0.5) / size;
    const isScanDark = y % scanPeriod === 0;
    const isGridY = y % gridStep === 0;

    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / size;
      const isGridX = x % gridStep === 0;

      // 1. Deep obsidian/plum radial background
      const distCenter = Math.hypot(nx - 0.46, ny - 0.52);
      const centerMix = 1 - smoothstep(0.05, 0.72, distCenter);
      const px: [number, number, number] = [
        BG_BASE[0] + (BG_GLOW[0] - BG_BASE[0]) * centerMix,
        BG_BASE[1] + (BG_GLOW[1] - BG_BASE[1]) * centerMix,
        BG_BASE[2] + (BG_GLOW[2] - BG_BASE[2]) * centerMix,
      ];

      // Subtle vignette darkening near edges for depth while keeping full-bleed square
      const edgeDist = Math.max(Math.abs(nx - 0.5), Math.abs(ny - 0.5));
      const vig = smoothstep(0.32, 0.5, edgeDist) * 0.28;
      px[0] *= 1 - vig;
      px[1] *= 1 - vig;
      px[2] *= 1 - vig;

      // 2. Subtle engineering grid + horizontal CRT scanlines
      if (isGridX || isGridY) {
        const gridAlpha = isGridX && isGridY ? 0.32 : 0.16;
        blend(px, GRID_COLOR, gridAlpha);
      }
      if (isScanDark) {
        px[0] *= 0.88;
        px[1] *= 0.88;
        px[2] *= 0.90;
      }

      // 3. Crisp inner terminal bezel & telemetry header bar (square-aligned, full-bleed safe)
      const frameOuter = sdBox(nx, ny, 0.5, 0.5, 0.41, 0.41);
      const frameRing = Math.abs(frameOuter) - 0.008;
      const frameAlpha = 1 - smoothstep(-aa, aa, frameRing);
      if (frameAlpha > 0) {
        blend(px, FRAME_COLOR, frameAlpha * 0.85);
      }

      // Subtle top status divider inside the terminal frame
      const dividerDist = sdSegment(nx, ny, 0.12, 0.21, 0.88, 0.21) - 0.004;
      const dividerAlpha = 1 - smoothstep(-aa, aa, dividerDist);
      if (dividerAlpha > 0) {
        blend(px, FRAME_COLOR, dividerAlpha * 0.65);
      }

      // Three miniature header telemetry pills on top-left inside frame
      const pillPositions: [number, RGB, number][] = [
        [0.18, CYAN_GLOW, 0.75],
        [0.245, AMBER_GLOW, 0.7],
        [0.31, FRAME_COLOR, 0.9],
      ];
      for (const [cx, color, strength] of pillPositions) {
        const dPill = Math.hypot(nx - cx, ny - 0.15) - 0.017;
        const aPill = 1 - smoothstep(-aa, aa, dPill);
        if (aPill > 0) {
          blend(px, color, aPill * strength);
        }
      }

      // 4. Terminal prompt chevron `>` (glowing cyan)
      const chevTop = sdSegment(nx, ny, 0.24, 0.39, 0.47, 0.55);
      const chevBot = sdSegment(nx, ny, 0.24, 0.71, 0.47, 0.55);
      const dChev = Math.min(chevTop, chevBot) - 0.042;

      // Soft bloom around chevron
      const chevGlow = Math.exp(-Math.max(0, dChev) * 18) * 0.42;
      if (chevGlow > 0.005) {
        addGlow(px, CYAN_GLOW, chevGlow);
      }
      // Crisp bright core
      const chevCore = 1 - smoothstep(-aa, aa, dChev);
      if (chevCore > 0) {
        blend(px, CYAN_CORE, chevCore);
        // Inner specular highlight along top-left edge
        const highlight = 1 - smoothstep(-aa, aa, dChev + 0.018);
        if (highlight > 0) {
          addGlow(px, [0x9a, 0xfb, 0xff], highlight * 0.35);
        }
      }

      // 5. Prompt underscore cursor `_` (glowing amber)
      const dCursor = sdBox(nx, ny, 0.655, 0.695, 0.125, 0.041);
      const cursorGlow = Math.exp(-Math.max(0, dCursor) * 17) * 0.45;
      if (cursorGlow > 0.005) {
        addGlow(px, AMBER_GLOW, cursorGlow);
      }
      const cursorCore = 1 - smoothstep(-aa, aa, dCursor);
      if (cursorCore > 0) {
        blend(px, AMBER_CORE, cursorCore);
        // Subtle top-edge highlight without diagonal box-distance crease
        const topRim = smoothstep(0.695, 0.654, ny);
        if (topRim > 0) {
          addGlow(px, [0xff, 0xe8, 0x99], cursorCore * topRim * 0.25);
        }
      }

      // 6. Fleet status beacon dot + concentric pulse ring (top-right inside frame)
      const bx = 0.76;
      const by = 0.335;
      const dBeaconCenter = Math.hypot(nx - bx, ny - by);
      const dDot = dBeaconCenter - 0.042;
      const dRing = Math.abs(dBeaconCenter - 0.088) - 0.009;

      // Beacon emerald glow
      const beaconGlow = Math.exp(-Math.max(0, dDot) * 18) * 0.48;
      if (beaconGlow > 0.005) {
        addGlow(px, BEACON_RING, beaconGlow);
      }
      const ringAlpha = 1 - smoothstep(-aa, aa, dRing);
      if (ringAlpha > 0) {
        blend(px, BEACON_RING, ringAlpha * 0.72);
      }
      const dotAlpha = 1 - smoothstep(-aa, aa, dDot);
      if (dotAlpha > 0) {
        blend(px, BEACON_CORE, dotAlpha);
        // Tiny bright specular pip
        const dSpec = Math.hypot(nx - (bx - 0.012), ny - (by - 0.012)) - 0.014;
        const specAlpha = 1 - smoothstep(-aa, aa, dSpec);
        if (specAlpha > 0) {
          blend(px, [0xe6, 0xff, 0xf5], specAlpha * 0.65);
        }
      }

      const off = (y * size + x) * 4;
      rgba[off] = Math.max(0, Math.min(255, Math.round(px[0])));
      rgba[off + 1] = Math.max(0, Math.min(255, Math.round(px[1])));
      rgba[off + 2] = Math.max(0, Math.min(255, Math.round(px[2])));
      rgba[off + 3] = 255; // Strictly opaque full-bleed square
    }
  }

  return new Uint8Array(encodePNG(rgba, size, size));
}

function writeIcon(outPath: string, size: number): { w: number; h: number; bytes: number } {
  mkdirSync(dirname(outPath), { recursive: true });
  const png = drawRexZeroIcon(size);
  writeFileSync(outPath, png);
  const decoded = decodePNG(readFileSync(outPath));
  if (decoded.w !== size || decoded.h !== size) {
    throw new Error(`icon ${outPath}: expected ${size}x${size}, got ${decoded.w}x${decoded.h}`);
  }
  for (let i = 3; i < decoded.rgba.length; i += 4) {
    if (decoded.rgba[i] !== 255) {
      throw new Error(`icon ${outPath}: non-opaque pixel found (alpha=${decoded.rgba[i]})`);
    }
  }
  return { w: decoded.w, h: decoded.h, bytes: png.length };
}

if (import.meta.main) {
  const storeIcon = resolve(ROOT, "store/icon.png");
  const launcherIcon = resolve(BUILD, "rex-zero-launcher.png");
  const s = writeIcon(storeIcon, 256);
  const l = writeIcon(launcherIcon, 100);
  console.log(`wrote ${storeIcon} (${s.w}x${s.h}, ${s.bytes} bytes)`);
  console.log(`wrote ${launcherIcon} (${l.w}x${l.h}, ${l.bytes} bytes)`);
}
