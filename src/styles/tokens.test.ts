import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolvePath(HERE, "..");
const NEEDLE = "mid" + "-gray";
const THEME_FILE = resolvePath(HERE, "theme.css");
const SELF_FILE = fileURLToPath(import.meta.url);
const EXTENSIONS = [".ts", ".tsx", ".css"];
const read = (path: string) =>
  readFileSync(resolvePath(SRC_ROOT, path), "utf8");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (EXTENSIONS.some((ext) => name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

type Theme = "light" | "dark";
type Rgb = [number, number, number];

/** Body of the first `selector {` block, braces balanced, comments removed. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no "${selector}" block`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) {
      return css.slice(open + 1, i).replace(/\/\*[\s\S]*?\*\//g, "");
    }
  }
  throw new Error(`unclosed "${selector}" block`);
}

function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    out[match[1]] = match[2].replace(/\s+/g, " ").trim();
  }
  return out;
}

/** The custom properties one theme sees: the `:root` palette with that theme's overrides. */
function parsePalette(css: string, theme: Theme): Record<string, string> {
  return {
    ...declarations(block(css, ":root")),
    ...declarations(block(css, `:root[data-theme="${theme}"]`)),
  };
}

function hex(value: string): Rgb {
  const digits = value.slice(1);
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((d) => d + d)
          .join("")
      : digits;
  assert.match(full, /^[0-9a-f]{6}$/i, `not a hex colour: ${value}`);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

function splitArgs(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of inner) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  out.push(current.trim());
  return out;
}

const blend = (a: Rgb, weight: number, b: Rgb): Rgb =>
  a.map((v, i) => weight * v + (1 - weight) * b[i]) as Rgb;

/** Evaluates a colour expression; anything translucent is composited on `under`. */
function evaluate(
  value: string,
  palette: Record<string, string>,
  under: Rgb,
): Rgb {
  const expr = value.trim();
  if (expr.startsWith("#")) return hex(expr);
  const variable = expr.match(/^var\(--([\w-]+)\)$/);
  if (variable) {
    const next = palette[variable[1]];
    assert.ok(next !== undefined, `undefined --${variable[1]}`);
    return evaluate(next, palette, under);
  }
  const mixed = expr.match(/^color-mix\((.*)\)$/);
  assert.ok(mixed, `unsupported colour: ${expr}`);
  const [space, first, second] = splitArgs(mixed[1]);
  assert.equal(space, "in srgb", `unsupported mix space: ${space}`);
  const part = (arg: string) => {
    const pct = arg.match(/^(.*?)\s+([\d.]+)%$/);
    return pct
      ? { colour: pct[1], weight: Number(pct[2]) / 100 }
      : { colour: arg, weight: null };
  };
  const a = part(first);
  const b = part(second);
  const weight = a.weight ?? (b.weight === null ? 0.5 : 1 - b.weight);
  const other =
    b.colour === "transparent" ? under : evaluate(b.colour, palette, under);
  return blend(evaluate(a.colour, palette, under), weight, other);
}

const THEME_CSS = readFileSync(THEME_FILE, "utf8");

/** A token (`ink-3` is `--color-ink-3`) or a hex literal, composited on the
 * surface it sits on; a translucent surface sits on the theme background. */
function resolve(token: string, theme: Theme, surface = "background"): Rgb {
  const palette = parsePalette(THEME_CSS, theme);
  const ref = (name: string) =>
    name.startsWith("#") ? name : `var(--color-${name})`;
  const page = evaluate(ref("background"), palette, [0, 0, 0]);
  const under =
    surface === "background" ? page : evaluate(ref(surface), palette, page);
  return evaluate(ref(token), palette, under);
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio. */
function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

interface Pair {
  fg: string;
  on: string;
  min: number;
  role: string;
  themes?: Theme[];
}

const onBoth = (fg: string, min: number, role: string): Pair[] =>
  ["background", "wash"].map((on) => ({ fg, on, min, role }));

/* R17 pairs. Out of the table: `line` and `wash` (dividers and fills, not
 * boundaries) and illustration tokens (demo-*, wordmark, mascot-line, logo-pastel). */
const PAIRS: Pair[] = [
  ...["text", "ink-2", "ink-3", "logo-primary"].flatMap((fg) =>
    onBoth(fg, 4.5, "text"),
  ),
  ...["error", "warning", "moss"].flatMap((fg) => [
    { fg, on: "background", min: 4.5, role: "status text" },
    { fg, on: `${fg}-wash`, min: 4.5, role: "Alert text" },
  ]),
  ...onBoth("line-strong", 3, "control boundary"),
  ...onBoth("logo-primary", 3, "focus ring and slider thumb"),
  ...onBoth("background-ui", 3, "focus ring and filled control"),
  // Dark keeps #da5893 (Phase 7 ruling F5): white on it is 3.62:1.
  {
    fg: "#ffffff",
    on: "background-ui",
    min: 4.5,
    role: "primary button label",
    themes: ["light"],
  },
  { fg: "background", on: "error", min: 4.5, role: "danger button label" },
];

/** Every pair that misses its target, one line each. */
function contrastFailures(): string[] {
  const failures: string[] = [];
  for (const theme of ["light", "dark"] as Theme[]) {
    for (const pair of PAIRS) {
      if (pair.themes && !pair.themes.includes(theme)) continue;
      const surface = resolve(pair.on, theme);
      const got = ratio(resolve(pair.fg, theme, pair.on), surface);
      if (got < pair.min) {
        failures.push(
          `${theme}: ${pair.fg} on ${pair.on} (${pair.role}) ${got.toFixed(2)} < ${pair.min}`,
        );
      }
    }
  }
  return failures;
}

/** Innermost rule blocks of a stylesheet as [selector, body]. */
function rules(css: string): [string, string][] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map(
    (m) => [m[1].trim(), m[2]] as [string, string],
  );
}

describe("theme tokens", () => {
  it("no_mid_gray_class_in_src", () => {
    const hits: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (file === THEME_FILE || file === SELF_FILE) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          const stripped = line.split("--color-" + NEEDLE).join("");
          if (stripped.includes(NEEDLE)) {
            hits.push(`${relative(SRC_ROOT, file)}:${index + 1}`);
          }
        });
    }
    assert.deepEqual(
      hits,
      [],
      `unregistered colour used at:\n${hits.join("\n")}`,
    );
  });

  it("contrast_pairs_hold_in_both_themes", () => {
    const page = hex("#fbfbfb");
    const ink = evaluate(
      "color-mix(in srgb, #0f0f0f 60%, transparent)",
      {},
      page,
    );
    assert.ok(
      Math.abs(ratio(ink, page) - 4.97) < 0.01,
      `resolver: #0f0f0f 60% over #fbfbfb is ${ratio(ink, page).toFixed(3)}, want 4.97`,
    );
    const grey = ratio(hex("#808080"), hex("#2c2b29"));
    assert.ok(
      Math.abs(grey - 3.58) < 0.01,
      `resolver: #808080 on #2c2b29 is ${grey.toFixed(3)}, want 3.58`,
    );
    const failures = contrastFailures();
    assert.deepEqual(
      failures,
      [],
      `pairs below target:\n${failures.join("\n")}`,
    );
  });

  it("illustrations_keep_the_pastel", () => {
    const pastel = (theme: Theme) => resolve("logo-pastel", theme).join(",");
    assert.equal(pastel("light"), hex("#faa2ca").join(","));
    assert.equal(pastel("dark"), resolve("logo-primary", "dark").join(","));
    const root = parsePalette(THEME_CSS, "light");
    assert.equal(
      root["light-color-wordmark"],
      "var(--light-color-logo-pastel)",
    );
    assert.match(
      root["light-demo-wallpaper"],
      /^radial-gradient\( 110% 80% at 90% 105%, color-mix\(in srgb, var\(--light-color-logo-pastel\) 50%, #fbfbfb\)/,
    );
    const overlay = read("overlay/RecordingOverlay.css");
    assert.match(
      overlay,
      /--s-accent: var\(--color-logo-pastel\);/,
      "the recording overlay accent is not the pastel",
    );
    assert.ok(
      !overlay.includes("--color-logo-primary"),
      "the recording overlay still uses logo-primary",
    );
    const demo = new Map(rules(read("components/onboarding/screens/demo.css")));
    assert.match(
      demo.get(".demo-pill-dot") ?? "",
      /background: var\(--color-logo-pastel\);/,
    );
    assert.match(
      demo.get(".demo-pill-spin") ?? "",
      /border-top-color: var\(--color-logo-pastel\);/,
    );
    assert.match(
      read("components/onboarding/screens/Demo.tsx"),
      /className="h-\[3px\] w-\[4px\] rounded-\[2px\] bg-logo-pastel /,
    );
    assert.match(
      block(read("App.css"), "@theme inline"),
      /--color-logo-pastel: var\(--color-logo-pastel\);/,
    );
  });

  it("slider_thumb_is_tinted", () => {
    const thumbs = rules(read("App.css")).filter(
      ([selector]) =>
        selector.includes("slider-thumb") || selector.includes("range-thumb"),
    );
    assert.equal(
      thumbs.length,
      1,
      `thumb rules: ${thumbs.map(([s]) => s).join(" | ")}`,
    );
    const [selector, body] = thumbs[0];
    assert.equal(
      selector,
      'input[type="range"].appearance-none::-webkit-slider-thumb',
    );
    assert.match(body, /background: var\(--color-logo-primary\);/);
    assert.match(body, /appearance: none;/);
  });

  it("no_raw_palette_classes", () => {
    const hits: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (/\.test\.[jt]sx?$/.test(file)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (
            /\b(?:text|bg)-(?:red|pink|blue|green|yellow|gray)-\d/.test(line)
          ) {
            hits.push(`${relative(SRC_ROOT, file)}:${index + 1}`);
          }
        });
    }
    assert.deepEqual(hits, [], `raw palette classes at:\n${hits.join("\n")}`);
  });

  it("history_error_is_an_alert", () => {
    assert.match(
      read("components/settings/history/HistorySettings.tsx"),
      /<div role="alert"[^>]*>\s*<Alert variant="error">\{actionError\}<\/Alert>\s*<\/div>/,
      "HistorySettings: actionError is not an error Alert inside a role=alert wrapper",
    );
  });
});
