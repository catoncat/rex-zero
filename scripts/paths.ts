import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
export const VENDOR = process.env.POCKETJS
  ? resolve(process.env.POCKETJS)
  : resolve(ROOT, "vendor/pocketjs");
export const BUILD = resolve(ROOT, ".build");
