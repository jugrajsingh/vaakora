/**
 * Brand gate: `bun scripts/check-brand.ts`. Prints `BRAND PASS`, or one FAIL
 * line per problem and exits 1. Sections are added by the tasks that own them;
 * this file holds `source` (brand.json, the SVG masters, the pinned fonts and
 * the generated rasters), `mirrors` (files that cannot read brand.json carry
 * literals of it, proven equal here), `theme` (src/styles/theme.css carries the
 * brand.json colour pairs and wires every active token to them) and `ui` (no
 * Handy name in locale values, its marks and release notes gone). `--dist` adds `dist`: the built frontend
 * bundle (`bun run build`) carries no Handy name in any value and no upstream
 * host.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { svgProblems } from "./brand-svg";
import { THEME_TOKENS, themeProblems, type BrandTheme } from "./brand-theme";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems: string[] = [];
const fail = (section: string, message: string) =>
  problems.push(`FAIL ${section}: ${message}`);

type Kind = "string" | "string|null" | "string[]" | "object";

const HEX = /^#[0-9a-f]{6}$/;

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
  "tray-colored-recording.png",
  "tray-colored-transcribing.png",
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

/** The brand fields the mirrored files must equal. */
interface Mirrored {
  displayName: string;
  appId: string;
  packageName: string;
  workerBinaryName: string;
  installDir: string;
  copyright: string[];
  updater?: { endpoint?: string | null };
}

function readText(rel: string): string | null {
  const path = join(ROOT, rel);
  if (!existsSync(path)) {
    fail("mirrors", `${rel} is missing`);
    return null;
  }
  return readFileSync(path, "utf8");
}

function readJson(rel: string): Record<string, unknown> | null {
  const text = readText(rel);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) return value;
    fail("mirrors", `${rel} is not an object`);
  } catch (e) {
    fail("mirrors", `${rel} does not parse: ${String(e)}`);
  }
  return null;
}

function readToml(rel: string): Record<string, unknown> | null {
  const text = readText(rel);
  if (text === null) return null;
  try {
    return Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (e) {
    fail("mirrors", `${rel} does not parse: ${String(e)}`);
    return null;
  }
}

function mirroredBrand(): Mirrored | null {
  const text = readText("brand.json");
  if (text === null) return null;
  try {
    const b = JSON.parse(text) as Mirrored;
    return b;
  } catch {
    return null; // `source` already reports an unparsable brand.json
  }
}

function equalLiteral(where: string, got: unknown, want: string) {
  if (got !== want) {
    fail(
      "mirrors",
      `${where} is ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
    );
  }
}

/** `bundle.linux.<kind>.files`: every key under the install dir or the licence. */
function checkBundleFiles(kind: "rpm" | "deb", files: unknown, b: Mirrored) {
  const where = `tauri.conf.json bundle.linux.${kind}.files`;
  if (!isRecord(files)) return fail("mirrors", `${where} is missing`);
  const licence = `/usr/share/licenses/${b.packageName}/LICENSE`;
  for (const key of Object.keys(files)) {
    const underInstallDir =
      key === b.installDir || key.startsWith(`${b.installDir}/`);
    if (!underInstallDir && key !== licence) {
      fail(
        "mirrors",
        `${where} key ${key} is neither under ${b.installDir} nor ${licence}`,
      );
    }
  }
  if (files[licence] !== "../LICENSE") {
    fail(
      "mirrors",
      `${where}[${licence}] is ${JSON.stringify(files[licence])}, want "../LICENSE"`,
    );
  }
}

/**
 * No update channel, no updater config: `brand.json` `updater.endpoint` null
 * means `tauri.conf.json` carries no `plugins.updater` and builds no updater
 * artifacts; it never names the upstream account, channel or not.
 */
function checkUpdaterOff(
  tauri: Record<string, unknown>,
  bundle: Record<string, unknown>,
  b: Mirrored,
) {
  if (/cjpais/i.test(JSON.stringify(tauri))) {
    fail("mirrors", "tauri.conf.json names cjpais");
  }
  if (b.updater?.endpoint !== null) return; // a channel exists: its own rules
  const plugins = isRecord(tauri.plugins) ? tauri.plugins : {};
  if ("updater" in plugins) {
    fail(
      "mirrors",
      "tauri.conf.json has plugins.updater but brand.json updater.endpoint is null",
    );
  }
  if (bundle.createUpdaterArtifacts !== false) {
    fail(
      "mirrors",
      `tauri.conf.json bundle.createUpdaterArtifacts is ${JSON.stringify(bundle.createUpdaterArtifacts)}, want false`,
    );
  }
}

function checkMirrors() {
  const b = mirroredBrand();
  if (!b) return;
  const tauri = readJson("src-tauri/tauri.conf.json");
  if (tauri) {
    equalLiteral(
      "tauri.conf.json productName",
      tauri.productName,
      b.displayName,
    );
    equalLiteral("tauri.conf.json identifier", tauri.identifier, b.appId);
    const bundle = isRecord(tauri.bundle) ? tauri.bundle : {};
    equalLiteral(
      "tauri.conf.json bundle.copyright",
      bundle.copyright,
      b.copyright.join("; "),
    );
    checkUpdaterOff(tauri, bundle, b);
    const linux = isRecord(bundle.linux) ? bundle.linux : {};
    for (const kind of ["rpm", "deb"] as const) {
      const section = linux[kind];
      checkBundleFiles(kind, isRecord(section) ? section.files : undefined, b);
    }
  }
  const cargo = readToml("src-tauri/Cargo.toml");
  if (cargo) {
    const pkg = isRecord(cargo.package) ? cargo.package : {};
    equalLiteral("src-tauri/Cargo.toml package name", pkg.name, b.packageName);
  }
  const pkgJson = readJson("package.json");
  if (pkgJson) equalLiteral("package.json name", pkgJson.name, b.packageName);
  const html = readText("index.html");
  if (html !== null) {
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
    equalLiteral("index.html title", title, b.displayName);
  }
  const tts = readToml("crates/handy-tts/Cargo.toml");
  if (tts) {
    const bins = Array.isArray(tts.bin) ? tts.bin : [];
    const names = bins.map((x) => (isRecord(x) ? x.name : undefined));
    if (!names.includes(b.workerBinaryName)) {
      fail(
        "mirrors",
        `crates/handy-tts/Cargo.toml has no [[bin]] named ${b.workerBinaryName} (found ${JSON.stringify(names)})`,
      );
    }
  }
}

/** `theme.css` mirrors `brand.json` theme: every pair equal, every active token wired. */
function checkTheme() {
  const text = readText("brand.json");
  const css = readText("src/styles/theme.css");
  if (text === null || css === null) return;
  let data: { theme?: BrandTheme; mark?: { keyline?: string } };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    return; // `source` already reports an unparsable brand.json
  }
  if (!data.theme || !data.mark?.keyline) return; // `source` reports it
  for (const problem of themeProblems(css, data.theme, data.mark.keyline)) {
    fail("theme", problem);
  }
}

type Json = string | { [key: string]: Json };

/** Every string leaf of a locale file as `path`, value. */
function leaves(node: Json, path: string): [string, string][] {
  if (typeof node === "string") return [[path, node]];
  return Object.entries(node).flatMap(([key, child]) =>
    leaves(child, path ? `${path}.${key}` : key),
  );
}

/** The locale keys whose own name carries Handy (internal ids, never shown). */
function keyNamesWithHandy(node: Json, out = new Set<string>()): Set<string> {
  if (typeof node === "string") return out;
  for (const [key, child] of Object.entries(node)) {
    if (/Handy/.test(key)) out.add(key);
    keyNamesWithHandy(child, out);
  }
  return out;
}

const LOCALES_DIR = join(ROOT, "src/i18n/locales");

function readLocales(): [string, Json][] {
  return readdirSync(LOCALES_DIR)
    .filter((d) => existsSync(join(LOCALES_DIR, d, "translation.json")))
    .sort()
    .flatMap((lang): [string, Json][] => {
      try {
        return [
          [
            lang,
            JSON.parse(
              readFileSync(join(LOCALES_DIR, lang, "translation.json"), "utf8"),
            ) as Json,
          ],
        ];
      } catch (e) {
        fail("ui", `${lang}/translation.json does not parse: ${String(e)}`);
        return [];
      }
    });
}

const GONE = [
  "src/components/icons/HandyTextLogo.tsx",
  "src/components/icons/HandyHand.tsx",
  "src/components/icons/HandyMascot.tsx",
  "src/components/shared/Mascot.tsx",
  "public/release-notes",
];

function checkUi() {
  const locales = readLocales();
  if (locales.length !== 27) {
    fail("ui", `${locales.length} locale files, want 27`);
  }
  for (const [lang, data] of locales) {
    for (const [path, text] of leaves(data, "")) {
      if (/\bhandy\b/i.test(text)) {
        fail("ui", `${lang} ${path} names Handy: ${JSON.stringify(text)}`);
      }
    }
  }
  for (const rel of GONE) {
    if (existsSync(join(ROOT, rel))) fail("ui", `${rel} must be deleted`);
  }
  const notes = join(ROOT, "src/content/release-notes");
  if (existsSync(notes)) {
    for (const name of readdirSync(notes)) {
      if (name !== "README.md") fail("ui", `release note ${name} must go`);
    }
  }
}

function distFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return distFiles(path);
    return /\.(js|css|html|json|svg|map)$/.test(name) ? [path] : [];
  });
}

/** A `Handy` hit with 40 characters of context either side. */
const HANDY_HIT = /Handy(?!Keys)/g;
const UPSTREAM_HOSTS = ["handy.computer", "github.com/cjpais"];

function checkDist() {
  const dir = join(ROOT, "dist");
  if (!existsSync(dir))
    return fail("dist", "dist/ is missing; run bun run build");
  const files = distFiles(dir);
  if (files.length === 0) return fail("dist", "dist/ holds no scanned files");
  // Locale key names that carry Handy (tts.sameAsHandy) appear in the bundle as
  // object keys and as t() arguments; they are ids, so mask them before scanning.
  const keyNames = new Set<string>();
  for (const [, data] of readLocales()) keyNamesWithHandy(data, keyNames);
  for (const file of files) {
    let text = readFileSync(file, "utf8");
    for (const key of keyNames) text = text.split(key).join("");
    const rel = file.slice(ROOT.length + 1);
    for (const m of text.matchAll(HANDY_HIT)) {
      const at = m.index ?? 0;
      const near = text
        .slice(Math.max(0, at - 40), at + 40)
        .replace(/\s+/g, " ");
      fail("dist", `${rel} names Handy near ${JSON.stringify(near)}`);
    }
    for (const host of UPSTREAM_HOSTS) {
      if (text.includes(host)) fail("dist", `${rel} contains ${host}`);
    }
  }
}

checkBrandJson();
checkMasters();
checkFonts();
checkRasters();
checkMirrors();
checkTheme();
checkUi();
if (process.argv.includes("--dist")) checkDist();

if (problems.length) {
  console.log(problems.join("\n"));
  process.exit(1);
}
console.log("BRAND PASS");
