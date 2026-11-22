/**
 * The `theme` section of the brand gate: `src/styles/theme.css` carries
 * literals of `brand.json` `theme` (a stylesheet cannot import JSON), proven
 * equal here. `check-brand.ts` runs it on the repository; `tokens.test.ts`
 * runs the same function on fixtures and on the real files.
 */

/** The 24 themed tokens, in brand.json order. */
export const THEME_TOKENS = [
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

export type ThemeName = "light" | "dark";
export type ThemeValues = Record<string, string>;
export type BrandTheme = Record<ThemeName, ThemeValues>;

/** One line, single spaces, no padding inside parentheses (prettier wraps long values). */
const squash = (value: string) =>
  value.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();

/** Body of the first `selector {` block, braces balanced, comments removed. */
export function blockBody(css: string, selector: string): string | null {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return null;
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) {
      return css.slice(open + 1, i).replace(/\/\*[\s\S]*?\*\//g, "");
    }
  }
  return null;
}

/** `--name: value;` pairs of one block body (nested blocks are not entered). */
export function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    out[match[1]] = squash(match[2]);
  }
  return out;
}

/**
 * Problems found when `css` does not mirror `theme`: a `--<theme>-color-<token>`
 * pair whose value differs from brand.json, an active `--color-<token>` that is
 * not wired to its pair in the `:root`, `prefers-color-scheme: dark` and
 * `data-theme` blocks, or a dark keyline that is not the mark's own keyline.
 */
export function themeProblems(
  css: string,
  theme: BrandTheme,
  markKeyline: string,
): string[] {
  const problems: string[] = [];
  const dark = blockBody(css, "@media (prefers-color-scheme: dark)");
  const blocks: [string, string | null, ThemeName][] = [
    [":root", blockBody(css, ":root"), "light"],
    [
      "@media dark :root",
      dark === null ? null : blockBody(dark, ":root"),
      "dark",
    ],
    [
      ':root[data-theme="light"]',
      blockBody(css, ':root[data-theme="light"]'),
      "light",
    ],
    [
      ':root[data-theme="dark"]',
      blockBody(css, ':root[data-theme="dark"]'),
      "dark",
    ],
  ];
  const root = blocks[0][1];
  if (root === null) return ["theme.css has no :root block"];
  const palette = declarations(root);
  for (const name of ["light", "dark"] as ThemeName[]) {
    for (const token of THEME_TOKENS) {
      const want = theme[name]?.[token];
      const prop = `${name}-color-${token}`;
      if (want === undefined) {
        problems.push(`brand.theme.${name}.${token} is missing`);
      } else if (palette[prop] === undefined) {
        problems.push(`theme.css declares no --${prop}`);
      } else if (palette[prop].toLowerCase() !== squash(want).toLowerCase()) {
        problems.push(
          `theme.css --${prop} is ${palette[prop]}, brand.theme.${name}.${token} is ${squash(want)}`,
        );
      }
    }
  }
  for (const [label, body, name] of blocks) {
    if (body === null) {
      problems.push(`theme.css has no ${label} block`);
      continue;
    }
    const active = declarations(body);
    for (const token of THEME_TOKENS) {
      const want = `var(--${name}-color-${token})`;
      if (active[`color-${token}`] !== want) {
        problems.push(
          `theme.css ${label} --color-${token} is ${active[`color-${token}`] ?? "missing"}, want ${want}`,
        );
      }
    }
  }
  const keyline = theme.dark?.["mark-keyline"];
  if (keyline !== undefined && keyline !== markKeyline) {
    problems.push(
      `brand.theme.dark.mark-keyline is ${keyline}, brand.mark.keyline is ${markKeyline}`,
    );
  }
  return problems;
}
