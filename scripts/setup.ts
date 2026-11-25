import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { ROOT, VENDOR } from "./paths.ts";

if (!existsSync(resolve(VENDOR, "package.json"))) {
  throw new Error("setup: vendor/pocketjs missing");
}

const links: [string, string][] = [
  ["node_modules/@pocketjs/framework", "."],
  ["node_modules/solid-js", "node_modules/solid-js"],
  ["node_modules/bun-types", "node_modules/bun-types"],
  ["node_modules/@types/bun", "node_modules/@types/bun"],
  ["node_modules/typescript", "node_modules/typescript"],
];

for (const [destination, source] of links) {
  const target = resolve(VENDOR, source);
  if (!existsSync(target)) {
    throw new Error(`setup: missing ${target}; run bun install in ${VENDOR}`);
  }
  const link = resolve(ROOT, destination);
  mkdirSync(dirname(link), { recursive: true });
  rmSync(link, { recursive: true, force: true });
  symlinkSync(relative(dirname(link), target), link, "dir");
}
console.log(`setup: linked node_modules -> ${relative(ROOT, VENDOR)}`);
