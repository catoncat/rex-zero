#!/usr/bin/env bun
// Master build, screenshot, store-policy check, .deb packager, and cp0 installer for Rex Zero.
//
//   bun scripts/zero.ts compile          -> .build/rex-zero.pocket
//   bun scripts/zero.ts build            -> aarch64 binary + tsnet + .pocket + icons
//   bun scripts/zero.ts shot             -> 6 official 320x170 Store PNG screenshots via --mock --shot
//   bun scripts/zero.ts deb              -> .build/rex-zero_<ver>-1_arm64.deb
//   bun scripts/zero.ts check            -> runs official CardputerZero Store policy scripts
//   bun scripts/zero.ts install [host]   -> installs .deb on cp0 and reloads APPLaunch

import { $ } from "bun";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { deb, walk } from "./deb.ts";
import { BUILD, ROOT, VENDOR } from "./paths.ts";

const { encodePNG } = (await import(join(VENDOR, "tools/png.ts"))) as {
  encodePNG(rgba: Uint8Array, w: number, h: number): Uint8Array;
};

const manifest = JSON.parse(readFileSync(join(ROOT, "pocket.json"), "utf8")) as {
  version: string;
};
const builder = JSON.parse(readFileSync(join(ROOT, "app-builder.json"), "utf8")) as {
  app_name: string;
  package_name: string;
  version: string;
  bin_name: string;
  description: string;
  store: Record<string, unknown> & {
    icon: string;
    screenshots: string[];
    author: { display_name: string; github?: string };
  };
};

if (builder.version !== manifest.version) {
  throw new Error(`Version mismatch: app-builder.json=${builder.version} vs pocket.json=${manifest.version}`);
}

const NAME = builder.package_name;
const VERSION = builder.version;
const REVISION = "1";
const MAINTAINER = "catoncat <catoncat@users.noreply.github.com>";
const CONFIG = "programs/cardputer-zero/pocket.runtime-config.ts";
const TARGET = "aarch64-unknown-linux-gnu";
const PROFILE_RS = join(BUILD, "profile", "pocket_profile.rs");
const POCKET = join(BUILD, `${NAME}.pocket`);
const PROGRAM = join(BUILD, "cargo", TARGET, "release", "pocket-cardputer-zero");
const HOST_PROGRAM = join(BUILD, "host", "debug", "pocket-cardputer-zero");
const TSNET_LINUX = join(BUILD, "tsnet", "rex-zero-tsnet-linux-arm64");
const [WIDTH, HEIGHT] = [320, 170];

const PREFIX = "/usr/share/APPLaunch";
const BINARY = `${PREFIX}/bin/${builder.bin_name}`;
const INSTALLED_POCKET = `${PREFIX}/share/${NAME}/${NAME}.pocket`;
const INSTALLED_TSNET = `${PREFIX}/lib/${NAME}/rex-zero-tsnet`;
const DOUBAO_PLUGIN_SRC = join(ROOT, "plugins", "doubao-asr-plugin.py");
const DOUBAO_FRONTIER_SRC = join(ROOT, "plugins", "doubao_frontier.py");

const DESKTOP = `[Desktop Entry]
Type=Application
Name=${builder.app_name}
Comment=${builder.description}
Exec=${BINARY} --package ${INSTALLED_POCKET} --input /dev/input/by-path/platform-3f804000.i2c-event
Icon=share/images/${NAME}.png
Terminal=false
`;

const ENV = {
  ...process.env,
  PATH: `${process.env.HOME}/.cargo/bin:/opt/homebrew/bin:${process.env.HOME}/.local/bin:${process.env.PATH ?? ""}`,
  POCKETJS_PROFILE_RS: PROFILE_RS,
};

function rgb565ToPng(raw: Uint8Array, scale = 1): Uint8Array {
  const outW = WIDTH * scale;
  const outH = HEIGHT * scale;
  const rgba = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < outW; x++) {
      const sx = Math.floor(x / scale);
      const at = (sy * WIDTH + sx) * 2;
      const v = raw[at]! | (raw[at + 1]! << 8);
      const o = (y * outW + x) * 4;
      rgba[o] = Math.round((((v >> 11) & 31) * 255) / 31);
      rgba[o + 1] = Math.round((((v >> 5) & 63) * 255) / 63);
      rgba[o + 2] = Math.round(((v & 31) * 255) / 31);
      rgba[o + 3] = 255;
    }
  }
  return encodePNG(rgba, outW, outH);
}

async function ensureIcons(): Promise<void> {
  if (existsSync(join(ROOT, "scripts/icon.ts"))) {
    await $`bun scripts/icon.ts`.cwd(ROOT).env(ENV);
  }
}

async function compilePocket(): Promise<void> {
  mkdirSync(join(BUILD, "profile"), { recursive: true });
  await $`bun tools/pocket.ts profile export --config ${CONFIG} --out ${join(BUILD, "profile")}`
    .cwd(VENDOR)
    .env(ENV);
  await $`bun tools/pocket.ts compile --manifest ${join(ROOT, "pocket.json")} --project-root ${ROOT} --runtime-config ${CONFIG} --plan-dir ${join(BUILD, "plan")} --outdir ${join(BUILD, "app-dist")} --output ${POCKET}`
    .cwd(VENDOR)
    .env(ENV);
}

async function buildAll(): Promise<void> {
  await ensureIcons();
  await $`python3 scripts/build-ghostty.py`.cwd(ROOT).env(ENV);
  if (existsSync(join(ROOT, "scripts/build-tsnet.sh"))) {
    await $`bash scripts/build-tsnet.sh`.cwd(ROOT).env(ENV);
  }
  await compilePocket();
  await $`cargo zigbuild --release -p pocket-cardputer-zero --target ${TARGET}.2.36 --target-dir ${join(BUILD, "cargo")}`
    .cwd(VENDOR)
    .env(ENV);
  console.log(`build ok:\n  program: ${PROGRAM}\n  pocket:  ${POCKET}`);
}

async function buildDeb(skipBuild = process.argv.includes("--skip-build")): Promise<string> {
  if (!skipBuild) {
    await buildAll();
  } else {
    await ensureIcons();
  }
  if (!existsSync(PROGRAM)) {
    throw new Error(`Missing required program binary: ${PROGRAM}`);
  }
  if (!existsSync(POCKET)) {
    throw new Error(`Missing required pocket bundle: ${POCKET}`);
  }
  if (!existsSync(TSNET_LINUX)) {
    throw new Error(`Missing required tsnet helper: ${TSNET_LINUX}`);
  }
  const stage = join(BUILD, "stage");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "usr/share/APPLaunch/bin"), { recursive: true });
  mkdirSync(join(stage, `usr/share/APPLaunch/share/${NAME}`), { recursive: true });
  mkdirSync(join(stage, "usr/share/APPLaunch/share/images"), { recursive: true });
  mkdirSync(join(stage, "usr/share/APPLaunch/applications"), { recursive: true });
  mkdirSync(join(stage, `usr/share/APPLaunch/lib/${NAME}/plugins`), { recursive: true });
  mkdirSync(join(stage, `usr/share/doc/${NAME}`), { recursive: true });

  copyFileSync(PROGRAM, join(stage, `usr/share/APPLaunch/bin/${builder.bin_name}`));
  copyFileSync(POCKET, join(stage, `usr/share/APPLaunch/share/${NAME}/${NAME}.pocket`));
  const tsnetDest = join(stage, `usr/share/APPLaunch/lib/${NAME}/rex-zero-tsnet`);
  copyFileSync(TSNET_LINUX, tsnetDest);
  chmodSync(tsnetDest, 0o755);
  if (existsSync(DOUBAO_PLUGIN_SRC)) {
    const pluginDest = join(stage, `usr/share/APPLaunch/lib/${NAME}/plugins/doubao-asr-plugin`);
    copyFileSync(DOUBAO_PLUGIN_SRC, pluginDest);
    chmodSync(pluginDest, 0o755);
  }
  if (existsSync(DOUBAO_FRONTIER_SRC)) {
    const frontierDest = join(stage, `usr/share/APPLaunch/lib/${NAME}/plugins/doubao_frontier.py`);
    copyFileSync(DOUBAO_FRONTIER_SRC, frontierDest);
    chmodSync(frontierDest, 0o644);
  }
  const launcherPng = existsSync(join(BUILD, "rex-zero-launcher.png"))
    ? join(BUILD, "rex-zero-launcher.png")
    : join(ROOT, builder.store.icon);
  copyFileSync(launcherPng, join(stage, `usr/share/APPLaunch/share/images/${NAME}.png`));
  writeFileSync(join(stage, `usr/share/APPLaunch/applications/${NAME}.desktop`), DESKTOP);
  writeFileSync(
    join(stage, `usr/share/doc/${NAME}/copyright`),
    `Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/\nUpstream-Name: ${NAME}\nLicense: MIT\n`,
  );

  let installedBytes = 0;
  const countBytes = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      const st = statSync(p);
      if (st.isDirectory()) countBytes(p);
      else installedBytes += st.size;
    }
  };
  countBytes(stage);

  const control = [
    `Package: ${NAME}`,
    `Version: ${VERSION}-${REVISION}`,
    `Section: devel`,
    `Priority: optional`,
    `Architecture: arm64`,
    `Installed-Size: ${Math.ceil(installedBytes / 1024)}`,
    `Depends: libc6 (>= 2.36), libstdc++6, libasound2t64 | libasound2, librime1t64, rime-data-pinyin-simp`,
    `Recommends: rime-data-double-pinyin, openssh-client, python3`,
    `Maintainer: ${MAINTAINER}`,
    `Description: ${builder.description}`,
    ``,
  ].join("\n");

  const entries = walk(stage, rel =>
    rel.startsWith("usr/share/APPLaunch/bin/") ||
    rel.endsWith("/rex-zero-tsnet") ||
    rel.endsWith("/doubao-asr-plugin"),
  );
  const outDeb = join(BUILD, `${NAME}_${VERSION}-${REVISION}_arm64.deb`);
  writeFileSync(outDeb, deb({ control }, [], entries, Math.floor(Date.now() / 1000)));
  console.log(`deb ok: ${outDeb} (${statSync(outDeb).size} bytes)`);
  return outDeb;
}

async function runShots(): Promise<void> {
  await ensureIcons();
  await $`python3 scripts/build-ghostty.py`.cwd(ROOT).env(ENV);
  await compilePocket();
  await $`cargo build -p pocket-cardputer-zero --target-dir ${join(BUILD, "host")}`
    .cwd(VENDOR)
    .env(ENV);

  const rawDir = join(BUILD, "shots-raw");
  const mockStoreDir = join(BUILD, "mock-store");
  rmSync(rawDir, { recursive: true, force: true });
  rmSync(mockStoreDir, { recursive: true, force: true });
  mkdirSync(rawDir, { recursive: true });
  const storeShotsDir = join(ROOT, "store/screenshots");
  const docsShotsDir = join(ROOT, "docs/screenshots");
  rmSync(storeShotsDir, { recursive: true, force: true });
  rmSync(docsShotsDir, { recursive: true, force: true });
  mkdirSync(storeShotsDir, { recursive: true });
  mkdirSync(docsShotsDir, { recursive: true });

  // Scripted deterministic tour across all 9 core scenes at 320x170 (12px compact font, zero toast overlap):
  //  1) 62  -> 01-inbox.png          (Priority Inbox / Recent Tasks, 4 cards visible)
  //  2) 86  -> 02-hosts.png          (Accordion Host Browser with mini's 2 windows)
  //  3) 110 -> 08-settings.png       (Settings & Multi-Connection Center)
  //  4) 142 -> 03-approval.png       (Live Reader + 1-Key Approval Card at 12px)
  //  5) 168 -> 05-voice-asr.png      (Streaming Voice Dictation + 8-bar Mic Meter)
  //  6) 244 -> 06-composer-ime.png   (Multi-Line Cursor Draft + Offline Rime Pinyin Candidates)
  //  7) 338 -> 04-terminal.png       (libghostty-vt Direct PTY ANSI Telemetry Table on cp0)
  //  8) 360 -> 07-quick-switch.png   (MRU Quick Switcher Overlay across recent tasks)
  //  9) 396 -> 09-tailnet-pair.png   (Userspace Tailscale & QR Pairing)
  const script =
    process.argv[3] && !process.argv[3].startsWith("--")
      ? process.argv[3]
      : [
          // Switch global font from 16px -> 14px -> 12px compact, wait for toast to fade (~35 ticks)
          "10:key:t",
          "16:key:t",
          "62:shot",
          // Tab 1: Accordion Host Browser -> select mini (has 2 windows)
          "70:key:Tab",
          "76:key:x",
          "86:shot",
          // Tab 2: Settings & Connection Center -> select ASR row to show contextual hint
          "94:key:Tab",
          "100:key:x",
          "110:shot",
          // Back to Tab 0 -> open Card 1 (mini approval) in crisp 12px Reader
          "118:key:Tab",
          "124:key:1",
          "142:shot",
          // Press v -> Live Streaming Voice Dictation
          "150:key:v",
          "168:shot",
          // Press Enter -> commit mock transcript into Multi-Line Draft, append text, type Rime Pinyin (already in 拼·全拼)
          "176:key:Enter",
          "190:type:，再核对打包和",
          "204:key:q",
          "208:key:u",
          "212:key:a",
          "216:key:n",
          "220:key:x",
          "224:key:i",
          "228:key:a",
          "232:key:n",
          "244:shot",
          // Clear rimeRaw (Esc) -> Close Composer (Esc) -> Leave Workspace safely (Backspace, never triggers Exit modal)
          "252:key:Escape",
          "260:key:Escape",
          "268:key:Backspace",
          // Open Card 4 (cp0 telemetry ANSI table) -> m (Direct PTY) -> wait 48 ticks for toast to fade
          "278:key:4",
          "288:key:m",
          "340:shot",
          // Open MRU Quick Switcher overlay (Control+Tab works even in direct-input PTY mode)
          "348:key:Control+Tab",
          "362:shot",
          // Close Quick Switch -> exit terminal (Alt+Backspace) -> open Tailscale & QR Pairing (g)
          "370:key:Escape",
          "378:key:Alt+Backspace",
          "386:key:g",
          "398:shot",
        ].join(" ");

  await $`${HOST_PROGRAM} --mock --package ${POCKET} --store ${mockStoreDir} --shot ${rawDir} --script ${script}`
    .cwd(ROOT)
    .env(ENV);

  const files = readdirSync(rawDir)
    .filter(n => n.endsWith(".rgb565"))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  // Frame index -> README 2x crisp filename & optional CardputerZero Store 1x (max 6) filename
  const specs: readonly { doc: string; store?: string }[] = [
    { doc: "01-inbox.png", store: "01-inbox.png" },
    { doc: "02-hosts.png", store: "02-hosts.png" },
    { doc: "08-settings.png" },
    { doc: "03-approval.png", store: "03-approval.png" },
    { doc: "05-voice-asr.png", store: "05-voice-asr.png" },
    { doc: "06-composer-ime.png" },
    { doc: "04-terminal.png", store: "04-terminal.png" },
    { doc: "07-quick-switch.png" },
    { doc: "09-tailnet-pair.png", store: "06-tailnet-pair.png" },
  ];
  const expectedFrameBytes = WIDTH * HEIGHT * 2;
  if (files.length !== specs.length) {
    throw new Error(
      `Expected ${specs.length} RGB565 screenshot frames in ${rawDir}, got ${files.length}: ${files.join(", ")}`,
    );
  }
  const frames = files.map(f => {
    const raw = readFileSync(join(rawDir, f));
    if (raw.byteLength !== expectedFrameBytes) {
      throw new Error(`Invalid RGB565 frame ${f}: got ${raw.byteLength} bytes, expected ${expectedFrameBytes}`);
    }
    return { file: f, raw };
  });
  frames.forEach(({ file, raw }, idx) => {
    const spec = specs[idx]!;
    const png2x = rgb565ToPng(raw, 2);
    writeFileSync(join(rawDir, file.replace(/\.rgb565$/, ".png")), png2x);
    writeFileSync(join(docsShotsDir, spec.doc), png2x);
    if (spec.store) {
      writeFileSync(join(storeShotsDir, spec.store), rgb565ToPng(raw, 1));
    }
  });
  console.log(`shots ok: ${frames.length} frames -> ${docsShotsDir} (2x) & ${storeShotsDir} (6 Store 1x)`);
}

async function checkStorePolicy(): Promise<void> {
  const debPath = join(BUILD, `${NAME}_${VERSION}-${REVISION}_arm64.deb`);
  if (!existsSync(debPath)) await buildDeb();

  const metaDir = join(BUILD, "policy-meta", NAME);
  rmSync(metaDir, { recursive: true, force: true });
  mkdirSync(join(metaDir, "screenshots"), { recursive: true });
  copyFileSync(join(ROOT, builder.store.icon), join(metaDir, basename(builder.store.icon)));
  const relShots: string[] = [];
  for (const s of builder.store.screenshots) {
    const dst = `screenshots/${basename(s)}`;
    copyFileSync(join(ROOT, s), join(metaDir, dst));
    relShots.push(dst);
  }
  const metaJson = {
    title: builder.app_name,
    ...builder.store,
    icon: basename(builder.store.icon),
    screenshots: relShots,
  };
  writeFileSync(join(metaDir, "meta.json"), JSON.stringify(metaJson, null, 2));

  const pathErr = join(BUILD, "bad-paths.txt");
  const metaErr = join(BUILD, "meta-errors.txt");
  const metaWarn = join(BUILD, "meta-warnings.txt");
  rmSync(pathErr, { force: true });
  rmSync(metaErr, { force: true });
  rmSync(metaWarn, { force: true });

  await $`python3 scripts/policy/install_path_policy.py ${NAME} ${debPath} ${pathErr}`.cwd(ROOT).env(ENV);
  await $`python3 scripts/policy/store_meta_policy.py ${NAME} ${metaDir} - ${metaErr} ${metaWarn}`.cwd(ROOT).env(ENV);

  const badPaths = existsSync(pathErr) ? readFileSync(pathErr, "utf8").trim() : "";
  const badMeta = existsSync(metaErr) ? readFileSync(metaErr, "utf8").trim() : "";
  const warns = existsSync(metaWarn) ? readFileSync(metaWarn, "utf8").trim() : "";
  if (warns) console.warn(`policy warnings:\n${warns}`);
  if (badPaths || badMeta) {
    throw new Error(`Store policy check failed:\n${badPaths}\n${badMeta}`);
  }
  console.log("STORE_POLICY_CHECK_OK (0 errors)");
}

async function installZero(host = "cp0"): Promise<void> {
  const debPath = await buildDeb();
  await $`scp -q ${debPath} ${host}:/tmp/${basename(debPath)}`.env(ENV);
  await $`ssh ${host} ${[
    "set -e",
    `sudo -n dpkg -i /tmp/${basename(debPath)}`,
    `rm -f /tmp/${basename(debPath)}`,
    `${BINARY} --check --package ${INSTALLED_POCKET}`,
    '(XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user restart APPLaunch.service || sudo -n systemctl restart APPLaunch.service)',
  ].join(" && ")}`.env(ENV);
  console.log(`installed ${basename(debPath)} onto ${host}`);
}

switch (process.argv[2]) {
  case "compile":
    await compilePocket();
    break;
  case "build":
    await buildAll();
    break;
  case "deb":
    await buildDeb();
    break;
  case "shot":
    await runShots();
    break;
  case "check":
    await checkStorePolicy();
    break;
  case "install": {
    const installHost = process.argv.slice(3).find(arg => !arg.startsWith("-")) ?? "cp0";
    await installZero(installHost);
    break;
  }
  default:
    console.error("usage: bun scripts/zero.ts compile | build | shot | deb [--skip-build] | check | install [host] [--skip-build]");
    process.exit(2);
}
