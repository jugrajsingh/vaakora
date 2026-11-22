/**
 * Brand gate: `bun scripts/check-brand.ts`. Prints `BRAND PASS`, or one FAIL
 * line per problem and exits 1. Sections are added by the tasks that own them;
 * this file holds `source` (brand.json, the SVG masters, the pinned fonts and
 * the generated rasters).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { svgProblems } from "./brand-svg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems: string[] = [];
const fail = (section: string, message: string) =>
  problems.push(`FAIL ${section}: ${message}`);

type Kind = "string" | "string|null" | "string[]" | "object";

const HEX = /^#[0-9a-f]{6}$/;
const THEME_TOKENS = [
  "text",
  "background",
  "surface",
  "logo-primary",
  "background-ui",
  "accent-on",
  "ink-2",
  "ink-3",
  "line",
  "line-strong",
  "wash",
  "sel",
  "sel-ink",
  "control",
  "knob",
  "moss",
  "error",
  "warning",
  "voice",
  "pill",
  "pill-text",
  "plum",
  "wordmark",
  "mark-keyline",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeOk(value: unknown, kind: Kind): boolean {
  if (kind === "string") return typeof value === "string" && value !== "";
  if (kind === "object") return isRecord(value);
  if (kind === "string|null") {
    return value === null || (typeof value === "string" && value !== "");
  }
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((x) => typeof x === "string" && x !== "")
  );
}

function checkObject(
  where: string,
  value: unknown,
  shape: Record<string, Kind>,
) {
  if (!isRecord(value)) return fail("source", `${where} is not an object`);
  for (const [key, kind] of Object.entries(shape)) {
    if (!(key in value)) fail("source", `${where}.${key} is missing`);
    else if (!typeOk(value[key], kind)) {
      fail("source", `${where}.${key} is not ${kind}`);
    }
  }
}

function checkBrandJson() {
  const path = join(ROOT, "brand.json");
  if (!existsSync(path)) return fail("source", "brand.json is missing");
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return fail("source", `brand.json does not parse: ${String(e)}`);
  }
  checkObject("brand", data, {
    displayName: "string",
    shortName: "string",
    appId: "string",
    packageName: "string",
    workerBinaryName: "string",
    installDir: "string",
    nativeNames: "object",
    links: "object",
    updater: "object",
    legacy: "object",
    copyright: "string[]",
    mark: "object",
    theme: "object",
  });
  if (!isRecord(data)) return;
  checkObject("brand.nativeNames", data.nativeNames, {
    pa: "string",
    hi: "string",
  });
  checkObject("brand.links", data.links, {
    repo: "string",
    issues: "string",
    docs: "string|null",
    website: "string|null",
  });
  checkObject("brand.updater", data.updater, {
    endpoint: "string|null",
    pubkey: "string|null",
  });
  checkObject("brand.legacy", data.legacy, { appId: "string" });
  checkObject("brand.mark", data.mark, {
    tile: "string",
    bars: "string",
    cursor: "string",
    keyline: "string",
  });
  if (isRecord(data.mark)) {
    for (const [k, v] of Object.entries(data.mark)) {
      if (typeof v === "string" && !HEX.test(v)) {
        fail("source", `brand.mark.${k} is not a #rrggbb colour`);
      }
    }
  }
  if (!isRecord(data.theme)) {
    fail("source", "brand.theme is not an object");
  } else {
    const shape: Record<string, Kind> = Object.fromEntries(
      THEME_TOKENS.map((t) => [t, "string"]),
    );
    checkObject("brand.theme.light", data.theme.light, shape);
    checkObject("brand.theme.dark", data.theme.dark, shape);
  }
  if (
    typeof data.displayName === "string" &&
    data.installDir !== `/usr/lib/${data.displayName}`
  ) {
    fail(
      "source",
      `brand.installDir is ${String(data.installDir)}, want /usr/lib/${data.displayName}`,
    );
  }
}

const MASTERS = [
  ...["16", "22", "24", "large"].flatMap((s) => [
    `brand/mark/vaakora-${s}.svg`,
    `brand/mark/vaakora-${s}-dark.svg`,
  ]),
  ...["16", "22", "24"].map((s) => `brand/tray/tray-${s}.svg`),
  "brand/wordmark/vaakora-latin.svg",
  "brand/wordmark/vaakora-pa.svg",
  "brand/wordmark/vaakora-hi.svg",
];

function checkMasters() {
  for (const rel of MASTERS) {
    const path = join(ROOT, rel);
    if (!existsSync(path)) {
      fail("source", `${rel} is missing`);
      continue;
    }
    for (const problem of svgProblems(readFileSync(path, "utf8"))) {
      fail("source", `${rel}: ${problem}`);
    }
  }
}

// google/fonts at 06bfe0d62a98375cb09c942fa18e68bd32cff057 (git blob shas)
const FONTS: Record<string, string> = {
  "brand/fonts/AnekLatin[wdth,wght].ttf":
    "50e2d9da453022dd15ab728caf8cedc14556035a",
  "brand/fonts/AnekGurmukhi[wdth,wght].ttf":
    "ca635975774d156b8b1c22bce535af7ac1e43c6a",
  "brand/fonts/AnekDevanagari[wdth,wght].ttf":
    "a40c71aa064fbc91a7f4ad86d801b5bb14d42979",
  "brand/fonts/OFL.txt": "6e46064f855d1d252f1f7d61e7dd1d5a07d409bf",
};

function checkFonts() {
  for (const [rel, sha] of Object.entries(FONTS)) {
    const path = join(ROOT, rel);
    if (!existsSync(path)) {
      fail("source", `${rel} is missing`);
      continue;
    }
    const body = readFileSync(path);
    const got = createHash("sha1")
      .update(`blob ${body.length}\0`)
      .update(body)
      .digest("hex");
    if (got !== sha) fail("source", `${rel} blob sha ${got}, want ${sha}`);
  }
}

/** Width and height from the PNG IHDR chunk. */
function pngSize(buf: Buffer): [number, number] | null {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) return null;
  if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

const TRAY_RASTERS = [
  "tray-dark-panel.png",
  "tray-light-panel.png",
  "tray-dark-panel-recording.png",
  "tray-light-panel-recording.png",
  "tray-colored.png",
  "tray-dark-panel-warning.png",
  "tray-light-panel-warning.png",
  "tray-colored-warning.png",
];
const APP_SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 512, 1024];

function checkRasters() {
  const want: [string, number][] = [
    ...APP_SIZES.map((s): [string, number] => [`app-${s}.png`, s]),
    ...TRAY_RASTERS.map((n): [string, number] => [n, 64]),
  ];
  for (const [name, size] of want) {
    const rel = `brand/generated/${name}`;
    const path = join(ROOT, rel);
    if (!existsSync(path)) {
      fail("source", `${rel} is missing`);
      continue;
    }
    const got = pngSize(readFileSync(path));
    if (!got) fail("source", `${rel} is not a PNG`);
    else if (got[0] !== size || got[1] !== size) {
      fail("source", `${rel} is ${got[0]}x${got[1]}, want ${size}x${size}`);
    }
  }
  if (!existsSync(join(ROOT, "brand/generated/wordmark-latin.json"))) {
    fail("source", "brand/generated/wordmark-latin.json is missing");
  }
}

checkBrandJson();
checkMasters();
checkFonts();
checkRasters();

if (problems.length) {
  console.log(problems.join("\n"));
  process.exit(1);
}
console.log("BRAND PASS");
