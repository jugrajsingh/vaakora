import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  THEME_TOKENS,
  themeProblems,
  type BrandTheme,
} from "../../scripts/brand-theme";

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
const BRAND = JSON.parse(
  readFileSync(resolvePath(SRC_ROOT, "..", "brand.json"), "utf8"),
) as { theme: BrandTheme; mark: { keyline: string } };

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
    name.startsWith("#") || name.startsWith("color-mix(")
      ? name
      : `var(--color-${name})`;
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

/** The opacity of every primary hover fill (`hover:bg-background-ui/<n>` next
 * to `text-accent-on`), read from the sources that paint one. */
function primaryHoverPercents(): number[] {
  const out: number[] = [];
  for (const file of [
    "components/ui/Button.tsx",
    "components/update-checker/UpdateChecker.tsx",
  ]) {
    const hover = read(file).match(/hover:bg-background-ui\/(\d+)/);
    assert.ok(hover, `${file} has no hover:bg-background-ui/<n>`);
    out.push(Number(hover[1]));
  }
  return out;
}

const onAll = (fg: string, min: number, role: string): Pair[] =>
  ["background", "surface", "wash"].map((on) => ({ fg, on, min, role }));

/* Contrast pairs (WCAG 2.x: 4.5 for text, 3 for edges, rings and graphics).
 * Out of the table: `line` and `wash` (dividers and fills, not boundaries) and
 * illustration tokens (demo-*, wordmark). */
const PAIRS: Pair[] = [
  ...["text", "ink-2", "ink-3", "logo-primary"].flatMap((fg) =>
    onAll(fg, 4.5, "text"),
  ),
  ...["error", "warning", "moss"].flatMap((fg) => [
    { fg, on: "background", min: 4.5, role: "status text" },
    { fg, on: `${fg}-wash`, min: 4.5, role: "Alert text" },
  ]),
  ...["background", "surface"].map((on) => ({
    fg: "line-strong",
    on,
    min: 3,
    role: "control boundary",
  })),
  ...onAll("logo-primary", 3, "focus ring and slider thumb"),
  ...onAll("background-ui", 3, "filled control"),
  { fg: "accent-on", on: "background-ui", min: 4.5, role: "primary label" },
  { fg: "sel-ink", on: "sel", min: 4.5, role: "selected row text" },
  { fg: "text", on: "sel", min: 4.5, role: "chip text" },
  { fg: "knob", on: "control", min: 3, role: "switch knob on its track" },
  { fg: "control", on: "background", min: 3, role: "switch track" },
  { fg: "background", on: "error", min: 4.5, role: "danger button label" },
  ...primaryHoverPercents().flatMap((percent) =>
    ["background", "surface"].map((ground) => ({
      fg: "accent-on",
      on: `color-mix(in srgb, var(--color-background-ui) ${percent}%, var(--color-${ground}))`,
      min: 4.5,
      role: `primary label on hover over ${ground}`,
    })),
  ),
  { fg: "pill-text", on: "pill", min: 4.5, role: "recording pill text" },
  { fg: "voice", on: "pill", min: 3, role: "live waveform on the pill" },
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

/** Shadow declarations in a source file: CSS `box-shadow` and `--*shadow*`
 * values (not the `--light|dark-color-shadow` tokens themselves), `drop-shadow(...)`, `boxShadow:` lines and `shadow-[...]` classes. */
function shadowDeclarations(file: string): { line: number; text: string }[] {
  const raw = readFileSync(file, "utf8");
  const text = file.endsWith(".css")
    ? raw.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
        comment.replace(/[^\n]/g, " "),
      )
    : raw;
  const out: { line: number; text: string }[] = [];
  const add = (index: number, value: string) =>
    out.push({
      line: text.slice(0, index).split("\n").length,
      text: value.replace(/\s+/g, " ").trim(),
    });
  const patterns = file.endsWith(".css")
    ? [
        /(?:box-shadow|--(?!(?:light|dark)-color-shadow:)[\w-]*shadow[\w-]*)\s*:\s*([^;}]*)/g,
      ]
    : [/boxShadow\s*:\s*([^\n]*)/g, /shadow-\[[^\]\s"'`]*\]/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      add(match.index ?? 0, match[1] ?? match[0]);
    }
  }
  for (const match of text.matchAll(/drop-shadow\(/g)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let end = start;
    for (; end < text.length && depth > 0; end++) {
      if (text[end] === "(") depth++;
      if (text[end] === ")") depth--;
    }
    add(match.index ?? 0, text.slice(start, end - 1));
  }
  return out;
}

const RAW_COLOUR =
  /(?<![a-z])(?:rgba?|hsla?|oklch|oklab)\(|#[0-9a-fA-F]{3,8}\b/i;

/** Raw colours inside a shadow property that are not drop shadows, keyed
 * "file: declaration". */
const NOT_A_SHADOW: Record<string, string> = {
  "components/onboarding/screens/demo.css: inset 0 0 0 1px rgb(255 255 255 / 0.08)":
    "white inset sheen on the demo laptop lid, not a shadow",
  "components/onboarding/screens/demo.css: inset 0 1px 0 rgb(255 255 255 / 0.35)":
    "white inset highlight on the demo key, not a shadow",
};

const SHADOW_STEPS = ["xs", "sm", "md", "lg", "xl", "2xl"];

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

  it("illustrations_use_the_voice_colour", () => {
    const voice = (theme: Theme) => resolve("voice", theme).join(",");
    assert.equal(voice("light"), hex("#a9e1b4").join(","));
    assert.equal(voice("dark"), hex("#a9e1b4").join(","));
    const root = parsePalette(THEME_CSS, "light");
    assert.equal(root["light-color-wordmark"], "var(--color-text)");
    assert.match(
      root["light-demo-wallpaper"],
      /^radial-gradient\( 110% 80% at 90% 105%, color-mix\(in srgb, var\(--light-color-voice\) 50%, #fbfbfb\)/,
    );
    const overlay = read("overlay/RecordingOverlay.css");
    assert.match(
      overlay,
      /--s-accent: var\(--color-voice\);/,
      "the recording overlay accent is not the voice colour",
    );
    assert.ok(
      !overlay.includes("--color-logo-primary"),
      "the recording overlay still uses logo-primary",
    );
    const demo = new Map(rules(read("components/onboarding/screens/demo.css")));
    assert.match(
      demo.get(".demo-pill-dot") ?? "",
      /background: var\(--color-voice\);/,
    );
    assert.match(
      demo.get(".demo-pill-spin") ?? "",
      /border-top-color: var\(--color-voice\);/,
    );
    assert.match(
      read("components/onboarding/screens/Demo.tsx"),
      /className="h-\[3px\] w-\[4px\] rounded-\[2px\] bg-voice /,
    );
    assert.match(
      block(read("App.css"), "@theme inline"),
      /--color-voice: var\(--color-voice\);/,
    );
  });

  it("recording_pill_is_neutral_in_both_themes", () => {
    const overlay = read("overlay/RecordingOverlay.css");
    const root = declarations(block(overlay, ":root"));
    assert.match(root["s-surface"], /var\(--color-pill\)/, "pill ground");
    assert.equal(root["s-ink"], "var(--color-pill-text)", "pill text");
    for (const theme of ["light", "dark"] as Theme[]) {
      const palette = parsePalette(THEME_CSS, theme);
      const ground = evaluate("var(--color-pill)", palette, [0, 0, 0]);
      for (const name of ["s-muted", "s-faint", "s-ink"]) {
        const got = ratio(evaluate(root[name], palette, ground), ground);
        assert.ok(
          got >= 4.5,
          `${theme}: --${name} on the pill ${got.toFixed(2)}`,
        );
      }
      for (const level of ["error", "warning"]) {
        const rule = rules(overlay).find(
          ([selector]) => selector === `.scard.level-${level}`,
        );
        assert.ok(rule, `no .scard.level-${level} rule`);
        const colour = rule[1].match(/--notice:\s*var\(--(dark-color-\w+)\)/);
        assert.ok(colour, `${level} notice is not read from the dark pair`);
        const got = ratio(
          evaluate(`var(--${colour[1]})`, palette, ground),
          ground,
        );
        assert.ok(
          got >= 4.5,
          `${theme}: ${level} notice on the pill ${got.toFixed(2)}`,
        );
      }
    }
  });

  it("theme_matches_brand_json", () => {
    assert.deepEqual(THEME_TOKENS.length, 24);
    assert.deepEqual(
      themeProblems(THEME_CSS, BRAND.theme, BRAND.mark.keyline),
      [],
    );
    // the same function must see a drifted value and an unwired token
    const drifted = THEME_CSS.replace(
      "--dark-color-accent-on: #101f13;",
      "--dark-color-accent-on: #ffffff;",
    );
    assert.notEqual(drifted, THEME_CSS, "fixture did not change");
    assert.ok(
      themeProblems(drifted, BRAND.theme, BRAND.mark.keyline).some((p) =>
        p.includes("--dark-color-accent-on"),
      ),
    );
    const unwired = THEME_CSS.replace(
      /(:root\[data-theme="dark"\] \{[\s\S]*?)--color-knob: var\(--dark-color-knob\);/,
      "$1",
    );
    assert.notEqual(unwired, THEME_CSS, "fixture did not change");
    assert.ok(
      themeProblems(unwired, BRAND.theme, BRAND.mark.keyline).some(
        (p) => p.includes("data-theme") && p.includes("--color-knob"),
      ),
    );
  });

  it("mark_keyline_is_transparent_in_light_and_the_mark_keyline_in_dark", () => {
    const literal = (theme: Theme): string => {
      let value = parsePalette(THEME_CSS, theme)["color-mark-keyline"];
      for (let hop = 0; hop < 4 && value?.startsWith("var("); hop++) {
        value = parsePalette(THEME_CSS, theme)[value.slice(6, -1)];
      }
      return value;
    };
    assert.equal(literal("light"), "transparent");
    assert.equal(literal("dark"), BRAND.mark.keyline);
    assert.equal(BRAND.theme.light["mark-keyline"], "transparent");
    // the mark paints its keyline with this token, so the dark ground shows it
    assert.match(
      read("components/brand/BrandMark.tsx"),
      /stroke:var\(--color-mark-keyline,transparent\)/,
    );
  });

  it("no_pink_left_in_the_theme", () => {
    const pink = new RegExp(
      ["c62c72", "f28cbb", "da5893", "faa2ca", "382731"].join("|"),
      "i",
    );
    const hits: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (file === SELF_FILE) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (
            pink.test(line) ||
            /logo-pastel|mascot-line|logo-stroke/.test(line)
          ) {
            hits.push(`${relative(SRC_ROOT, file)}:${index + 1}`);
          }
        });
    }
    assert.deepEqual(
      hits,
      [],
      `old pink tokens or values at:\n${hits.join("\n")}`,
    );
  });

  it("selection_and_switches_are_neutral", () => {
    const sidebar = read("components/Sidebar.tsx");
    const active = sidebar.match(/isActive \? "([^"]*)" : "hover:bg-wash"/);
    assert.ok(active, "no active class string in Sidebar.tsx");
    assert.ok(active[1].includes("bg-sel text-sel-ink"), active[1]);
    assert.ok(!active[1].includes("logo-primary"), active[1]);
    for (const file of ["ToggleSwitch", "Switch"]) {
      const source = read(`components/ui/${file}.tsx`);
      assert.ok(
        !/peer-checked:bg-(?:background-ui|logo-primary)/.test(source),
        file,
      );
    }
    const track = read("components/ui/Switch.tsx");
    assert.ok(track.includes("peer-checked:bg-control"), "Switch on track");
    assert.ok(track.includes("after:bg-knob"), "Switch knob");
    assert.ok(!track.includes("after:bg-white"), "Switch knob is white");
    assert.ok(!track.includes("peer-checked:after:border-white"), "knob edge");
    assert.ok(
      read("components/ui/ToggleSwitch.tsx").includes("<Switch"),
      "ToggleSwitch no longer renders Switch",
    );
    const primary = read("components/ui/Button.tsx").match(
      /primary:\s*"([^"]*)"/,
    );
    assert.ok(primary, "no primary variant in Button.tsx");
    assert.ok(primary[1].includes("text-accent-on"), primary[1]);
    assert.ok(!primary[1].includes("text-white"), primary[1]);
    const radio = read("components/ui/Radio.tsx");
    assert.ok(!radio.includes("text-white"), "Radio paints text-white");
    assert.ok(
      radio.includes("bg-control") && radio.includes("text-knob"),
      "Radio checked is not control and knob",
    );
    const update = read("components/update-checker/UpdateChecker.tsx");
    assert.ok(
      !update.includes("text-white"),
      "UpdateChecker paints text-white",
    );
    assert.ok(
      update.includes("bg-background-ui text-accent-on"),
      "UpdateChecker download button is not the primary action",
    );
    for (const [file, needle] of [
      ["components/settings/PositionGrid.tsx", "bg-control"],
      ["components/settings/LanguageSelector.tsx", "bg-sel text-sel-ink"],
      ["components/ui/Dropdown.tsx", "bg-sel"],
      ["components/settings/tts/history/ReadingView.tsx", "bg-sel ring-2"],
      [
        "components/settings/tts/vocabulary/VoiceChips.tsx",
        "bg-sel text-sel-ink",
      ],
    ] as const) {
      assert.ok(read(file).includes(needle), `${file} lacks ${needle}`);
    }
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

  it("shadow_colour_is_one_token_pair", () => {
    const root = declarations(block(THEME_CSS, ":root"));
    assert.ok(root["light-color-shadow"], "no --light-color-shadow");
    assert.ok(root["dark-color-shadow"], "no --dark-color-shadow");
    const dark = block(THEME_CSS, "@media (prefers-color-scheme: dark)");
    const mapped: [string, string][] = [
      [block(THEME_CSS, ":root"), "light"],
      [block(dark, ":root"), "dark"],
      [block(THEME_CSS, ':root[data-theme="light"]'), "light"],
      [block(THEME_CSS, ':root[data-theme="dark"]'), "dark"],
    ];
    for (const [body, theme] of mapped) {
      assert.equal(
        declarations(body)["color-shadow"],
        `var(--${theme}-color-shadow)`,
        `--color-shadow is not mapped to the ${theme} token`,
      );
    }
    assert.match(
      block(read("App.css"), "@theme inline"),
      /--color-shadow: var\(--color-shadow\);/,
      "--color-shadow is not registered with Tailwind",
    );
  });

  it("tailwind_shadow_steps_in_use_take_the_token", () => {
    const used = new Set<string>();
    for (const file of walk(SRC_ROOT)) {
      if (/\.test\.[jt]sx?$/.test(file)) continue;
      for (const match of readFileSync(file, "utf8").matchAll(
        /(?<![\w-])shadow-(xs|sm|md|lg|xl|2xl)(?![\w-])/g,
      )) {
        used.add(match[1]);
      }
    }
    const theme = declarations(block(read("App.css"), "@theme"));
    for (const step of SHADOW_STEPS) {
      if (!used.has(step)) continue;
      assert.match(
        theme[`shadow-${step}`] ?? "",
        /var\(--color-shadow\)/,
        `shadow-${step} is used but App.css does not build it from --color-shadow`,
      );
    }
  });

  it("no_raw_colour_in_a_shadow", () => {
    const hits: string[] = [];
    const seen = new Set<string>();
    for (const file of walk(SRC_ROOT)) {
      if (/\.test\.[jt]sx?$/.test(file)) continue;
      const name = relative(SRC_ROOT, file);
      for (const { line, text } of shadowDeclarations(file)) {
        if (!RAW_COLOUR.test(text)) continue;
        const key = `${name}: ${text}`;
        if (key in NOT_A_SHADOW) seen.add(key);
        else hits.push(`${name}:${line} ${text}`);
      }
    }
    assert.deepEqual(
      hits,
      [],
      `shadow colour must come from --color-shadow:\n${hits.join("\n")}`,
    );
    assert.deepEqual(
      Object.keys(NOT_A_SHADOW).filter((key) => !seen.has(key)),
      [],
      "stale NOT_A_SHADOW entries",
    );
  });

  it("history_error_is_an_alert", () => {
    assert.match(
      read("components/settings/history/HistorySettings.tsx"),
      /<div role="alert"[^>]*>\s*<Alert variant="error">\{actionError\}<\/Alert>\s*<\/div>/,
      "HistorySettings: actionError is not an error Alert inside a role=alert wrapper",
    );
  });
});
