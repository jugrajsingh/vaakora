/**
 * Docs gate: pure rules over an in-memory file map of `README.md` and every
 * file under `docs/` (plus the repository files the README links, so a link to
 * `CHANGELOG.md` can be proven to resolve). `check-docs.ts` runs them on the
 * repository; `src/docs-site.test.ts` runs them on fixtures and on the real
 * tree, so the gate's frontend-tests step enforces them. Node built-ins and the
 * two helpers of `brand-theme.ts` only, so it runs on the host without
 * `node_modules`.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { blockBody, declarations } from "./brand-theme";

/** Repo-relative POSIX paths to bytes: `README.md`, every file under `docs/`, files the README links. */
export type Tree = Map<string, Uint8Array>;

export interface Brand {
  theme: { light: Record<string, string>; dark: Record<string, string> };
  mark: Record<string, string>;
}

/** Contents of `brand/mark/vaakora-large.svg`, `...-large-dark.svg` and `brand/wordmark/vaakora-latin.svg`. */
export interface BrandSources {
  mark: string;
  markDark: string;
  wordmark: string;
}

export const LIMITS = {
  still: 100 * 1024,
  clip: 800 * 1024,
  svg: 32 * 1024,
  total: 3 * 1024 * 1024,
};

export const NAMED_COLOURS = [
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
];

type Rule = (tree: Tree, brand: Brand, sources: BrandSources) => string[];

const SHIELDS = "https://img.shields.io/badge/";
const ASSETS = "docs/assets/";
const BRAND_DIR = "docs/assets/brand/";
const SYNC_HINT = "run bun scripts/check-docs.ts --sync-brand";
const TEXT_FILE = /\.(html|css|svg|md|txt|json|xml|js)$/i;
const REF_FILE = /\.(html|css|md)$/i;
const PAGE = /^docs\/[^/]+\.html$/;
const LIGHT_ASSET = /^docs\/assets\/.*-light\.(webp|svg)$/;
const MARK_SRC = /(^|\/)assets\/brand\/mark(-dark)?\.svg$/;
const MD_IMAGE =
  /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const MD_LINK =
  /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const PRIVATE_IP =
  /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?!\d)/g;
const PRIVATE_MARKERS = [
  "/home/",
  "/run/user/",
  "/Users/",
  ".superpowers",
  ".scratch",
  ".worktrees",
  "localhost",
  "127.0.0.1",
];

/** U+2014, written as a code point so this file holds none. */
const EM_DASH = String.fromCharCode(0x2014);
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const decode = (data: Uint8Array) => decoder.decode(data);
const fail = (rule: string, path: string, detail: string) =>
  `FAIL ${rule}: ${path}: ${detail}`;

/** One line, single spaces, no padding inside parentheses, lower case (prettier wraps long values). */
const norm = (value: string) =>
  value
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")")
    .trim()
    .toLowerCase();

/** `README.md` and every `docs/` file of a kind: `[path, text]`. */
function filesOf(tree: Tree, kind: RegExp): [string, string][] {
  return [...tree]
    .filter(
      ([path]) =>
        (path === "README.md" || path.startsWith("docs/")) && kind.test(path),
    )
    .map(([path, data]): [string, string] => [path, decode(data)]);
}

const hasDocs = (tree: Tree) =>
  [...tree.keys()].some((p) => p.startsWith("docs/"));

/** Text to scan for references: HTML comments removed, and for Markdown code removed. */
function sourceText(path: string, text: string): string {
  if (path.endsWith(".css")) return text;
  const out = text.replace(/<!--[\s\S]*?-->/g, "");
  if (!path.endsWith(".md")) return out;
  return out.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

interface Tag {
  name: string;
  attrs: Map<string, string>;
  index: number;
}

function parseAttrs(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of source.matchAll(
    /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g,
  )) {
    attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function htmlTags(text: string): Tag[] {
  return [
    ...text.matchAll(/<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g),
  ].map((m) => ({
    name: m[1].toLowerCase(),
    attrs: parseAttrs(m[2]),
    index: m.index ?? 0,
  }));
}

/** Targets of CSS `url()`; `url(#id)` points inside the document and is skipped. */
function cssUrls(css: string): string[] {
  return [...css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? "")
    .filter((url) => url !== "" && !url.startsWith("#"));
}

const candidates = (srcset: string) =>
  srcset
    .split(",")
    .map((c) => c.trim().split(/\s+/)[0])
    .filter((url) => url !== "");

interface Ref {
  url: string;
  /** An image, stylesheet or other file the page loads (an `<a>` or Markdown link is not). */
  asset: boolean;
}

function collectRefs(path: string, text: string): Ref[] {
  const src = sourceText(path, text);
  const refs: Ref[] = [];
  const asset = (url: string | undefined) => {
    if (url !== undefined) refs.push({ url, asset: true });
  };
  if (path.endsWith(".css")) {
    cssUrls(src).forEach(asset);
    return refs;
  }
  for (const tag of htmlTags(src)) {
    if (tag.name === "img" || tag.name === "source") {
      asset(tag.attrs.get("src"));
      candidates(tag.attrs.get("srcset") ?? "").forEach(asset);
    } else if (tag.name === "link") {
      asset(tag.attrs.get("href"));
    } else if (tag.name === "a" && tag.attrs.has("href")) {
      refs.push({ url: tag.attrs.get("href") ?? "", asset: false });
    }
    cssUrls(tag.attrs.get("style") ?? "").forEach(asset);
  }
  for (const m of src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    cssUrls(m[1]).forEach(asset);
  }
  if (path.endsWith(".md")) {
    for (const m of src.matchAll(MD_IMAGE)) asset(m[2]);
    const rest = src.replace(MD_IMAGE, (whole) => " ".repeat(whole.length));
    for (const m of rest.matchAll(MD_LINK)) {
      refs.push({ url: m[1], asset: false });
    }
  }
  return refs;
}

type Resolved =
  | { kind: "external" }
  | { kind: "bad"; why: string }
  | { kind: "local"; path: string; fragment: string };

/** The published site: a link to it is checked against `docs/`, which is its root. */
const SITE = "https://vaakora.jugraj.dev/";

/** Where `url`, written in `from`, points: another host, a repo path, or nowhere acceptable. */
function resolveUrl(from: string, url: string): Resolved {
  let raw = url.trim();
  const onSite = raw.startsWith(SITE);
  if (onSite) {
    raw = raw.slice(SITE.length);
    if (raw === "" || raw.startsWith("#") || raw.startsWith("?")) {
      raw = "index.html" + raw;
    }
  }
  if (
    !onSite &&
    (raw.startsWith("//") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw))
  ) {
    return { kind: "external" };
  }
  if (raw.startsWith("/")) {
    return {
      kind: "bad",
      why: "is an absolute path (a host serves docs/ as the site root, a disk copy does not)",
    };
  }
  const hash = raw.indexOf("#");
  const fragment = hash >= 0 ? raw.slice(hash + 1) : "";
  const beforeHash = hash >= 0 ? raw.slice(0, hash) : raw;
  const query = beforeHash.indexOf("?");
  const target = query >= 0 ? beforeHash.slice(0, query) : beforeHash;
  if (target === "") return { kind: "local", path: from, fragment };
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return { kind: "bad", why: "is not a valid URL" };
  }
  const path = onSite
    ? posix.normalize(posix.join("docs", decoded))
    : posix.normalize(posix.join(posix.dirname(from), decoded));
  if (path === ".." || path.startsWith("../")) {
    return { kind: "bad", why: "leaves the repository" };
  }
  if ((onSite || from.startsWith("docs/")) && !path.startsWith("docs/")) {
    return { kind: "bad", why: "leaves docs/" };
  }
  return { kind: "local", path, fragment };
}

const exists = (tree: Tree, path: string) =>
  tree.has(path) ||
  [...tree.keys()].some((key) => key.startsWith(path.replace(/\/$/, "") + "/"));

function idsOf(text: string): Set<string> {
  const ids = new Set<string>();
  for (const tag of htmlTags(sourceText("x.html", text))) {
    const id = tag.attrs.get("id");
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

export const refsProblems: Rule = (tree) => {
  const problems: string[] = [];
  const ids = new Map<string, Set<string>>();
  for (const [path, text] of filesOf(tree, REF_FILE)) {
    for (const ref of collectRefs(path, text)) {
      const res = resolveUrl(path, ref.url);
      if (res.kind === "external") {
        if (ref.asset) {
          if (!(path === "README.md" && ref.url.startsWith(SHIELDS))) {
            problems.push(
              fail(
                "refs",
                path,
                `${ref.url} is external (only README.md may load ${SHIELDS} images; docs load nothing from another host)`,
              ),
            );
          }
        } else if (!/^(https?:|mailto:|\/\/)/i.test(ref.url.trim())) {
          problems.push(
            fail(
              "refs",
              path,
              `${ref.url} uses a scheme the docs do not allow`,
            ),
          );
        }
        continue;
      }
      if (res.kind === "bad") {
        problems.push(fail("refs", path, `${ref.url} ${res.why}`));
      } else if (!exists(tree, res.path)) {
        problems.push(
          fail("refs", path, `${ref.url} does not exist (${res.path})`),
        );
      } else if (res.fragment !== "" && PAGE.test(res.path)) {
        if (!ids.has(res.path)) {
          ids.set(
            res.path,
            idsOf(decode(tree.get(res.path) ?? new Uint8Array())),
          );
        }
        if (!ids.get(res.path)?.has(res.fragment)) {
          problems.push(
            fail(
              "refs",
              path,
              `${ref.url} has no id="${res.fragment}" in ${res.path}`,
            ),
          );
        }
      }
    }
  }
  return problems;
};

export const orphansProblems: Rule = (tree) => {
  const referenced = new Set<string>();
  for (const [path, text] of filesOf(tree, REF_FILE)) {
    for (const ref of collectRefs(path, text)) {
      const res = resolveUrl(path, ref.url);
      if (res.kind === "local") referenced.add(res.path);
    }
  }
  return [...tree.keys()]
    .filter((path) => path.startsWith(ASSETS) && !referenced.has(path))
    .map((path) =>
      fail(
        "orphans",
        path,
        "no README, page or stylesheet references this file",
      ),
    );
};

export const budgetProblems: Rule = (tree) => {
  const problems: string[] = [];
  let total = 0;
  for (const [path, data] of tree) {
    if (!path.startsWith(ASSETS)) continue;
    total += data.length;
    const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
    if (![".webp", ".svg", ".css"].includes(ext)) {
      problems.push(
        fail(
          "budget",
          path,
          "only .webp, .svg and .css files live under docs/assets",
        ),
      );
      continue;
    }
    let limit = Infinity;
    if (ext === ".svg") limit = LIMITS.svg;
    if (ext === ".webp") {
      limit = path.startsWith("docs/assets/clips/")
        ? LIMITS.clip
        : LIMITS.still;
    }
    if (data.length > limit) {
      problems.push(
        fail(
          "budget",
          path,
          `${data.length} bytes is over the ${limit} byte limit`,
        ),
      );
    }
  }
  if (total > LIMITS.total) {
    problems.push(
      fail(
        "budget",
        "docs/assets",
        `total ${total} bytes is over the ${LIMITS.total} byte limit`,
      ),
    );
  }
  return problems;
};

export const pairsProblems: Rule = (tree) => {
  const problems: string[] = [];
  for (const path of tree.keys()) {
    const m = /^(docs\/assets\/screens\/.+)-(light|dark)\.webp$/.exec(path);
    if (m === null) continue;
    const twin = `${m[1]}-${m[2] === "light" ? "dark" : "light"}.webp`;
    if (!tree.has(twin)) problems.push(fail("pairs", path, `no twin ${twin}`));
  }
  for (const [path, text] of filesOf(tree, /\.(html|md)$/i)) {
    const src = sourceText(path, text);
    const pictures = [
      ...src.matchAll(/<picture\b[^>]*>([\s\S]*?)<\/picture>/gi),
    ].map((m) => ({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      tags: htmlTags(m[1]),
    }));
    const lightTarget = (url: string) => {
      const res = resolveUrl(path, url);
      return res.kind === "local" && LIGHT_ASSET.test(res.path)
        ? res.path
        : null;
    };
    for (const img of htmlTags(src).filter((t) => t.name === "img")) {
      const url = img.attrs.get("src") ?? "";
      const target = lightTarget(url);
      if (target === null) continue;
      const picture = pictures.find(
        (p) => img.index >= p.start && img.index < p.end,
      );
      const twin = target.replace(/-light\.(webp|svg)$/, "-dark.$1");
      if (picture === undefined) {
        problems.push(
          fail(
            "pairs",
            path,
            `${url} (${target}) is not inside a <picture> with a dark <source> for ${twin}`,
          ),
        );
        continue;
      }
      const source = picture.tags.find(
        (t) =>
          t.name === "source" &&
          candidates(t.attrs.get("srcset") ?? "").some((u) => {
            const res = resolveUrl(path, u);
            return res.kind === "local" && res.path === twin;
          }),
      );
      if (source === undefined) {
        problems.push(
          fail(
            "pairs",
            path,
            `${url} (${target}) has no <source srcset> for ${twin} in its <picture>`,
          ),
        );
      } else if (
        !/prefers-color-scheme:\s*dark/i.test(source.attrs.get("media") ?? "")
      ) {
        problems.push(
          fail(
            "pairs",
            path,
            `the <source> for ${twin} needs media="(prefers-color-scheme: dark)"`,
          ),
        );
      }
    }
    for (const m of src.matchAll(MD_IMAGE)) {
      const target = lightTarget(m[2]);
      if (target !== null) {
        problems.push(
          fail(
            "pairs",
            path,
            `Markdown image ${m[2]} (${target}) must be a <picture> with a dark <source>`,
          ),
        );
      }
    }
  }
  return problems;
};

/** Values of every declaration in a stylesheet or style attribute, comments, urls and strings removed. */
function declarationValues(css: string): { property: string; value: string }[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/([\w-]+)\s*:\s*([^;{}]+)(?=[;}])/g)].map((m) => ({
    property: m[1],
    value: m[2]
      .replace(/url\([^)]*\)/gi, "")
      .replace(/"[^"]*"|'[^']*'/g, "")
      .trim(),
  }));
}

function styleSources(path: string, text: string): string[] {
  if (path.endsWith(".css")) return [text];
  const out = [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(
    (m) => m[1],
  );
  for (const tag of htmlTags(text)) {
    const style = tag.attrs.get("style");
    if (style !== undefined) out.push(`${style};`);
  }
  return out;
}

function tokenProblems(path: string, css: string, brand: Brand): string[] {
  const problems: string[] = [];
  const media = blockBody(css, "@media (prefers-color-scheme: dark)");
  const blocks: [string, string | null, "light" | "dark"][] = [
    [":root", blockBody(css, ":root"), "light"],
    [
      "@media (prefers-color-scheme: dark) :root",
      media === null ? null : blockBody(media, ":root"),
      "dark",
    ],
  ];
  for (const [label, body, theme] of blocks) {
    if (body === null) continue;
    for (const [name, value] of Object.entries(declarations(body))) {
      if (!name.startsWith("color-")) continue;
      const token = name.slice("color-".length);
      const want = brand.theme[theme][token];
      if (want === undefined) {
        problems.push(
          fail(
            "colours",
            path,
            `--${name} in ${label} is not a brand.json theme token`,
          ),
        );
      } else if (norm(value) !== norm(want)) {
        problems.push(
          fail(
            "colours",
            path,
            `--${name} in ${label} is ${value}, brand.theme.${theme}.${token} is ${want}`,
          ),
        );
      }
    }
  }
  return problems;
}

export const coloursProblems: Rule = (tree, brand) => {
  const problems: string[] = [];
  const palette = new Set(
    [
      ...Object.values(brand.theme.light),
      ...Object.values(brand.theme.dark),
      ...Object.values(brand.mark),
    ]
      .filter((value) => /^#[0-9a-fA-F]{6}$/.test(value))
      .map((value) => value.toLowerCase()),
  );
  const named = new Set(NAMED_COLOURS);
  for (const [path, text] of filesOf(tree, /\.(html|css)$/i)) {
    for (const source of styleSources(path, text)) {
      for (const { property, value } of declarationValues(source)) {
        const found: string[] = [];
        for (const m of value.matchAll(/#[0-9a-fA-F]{3,8}(?![\w-])/g)) {
          if (!palette.has(m[0].toLowerCase())) {
            found.push(`colour ${m[0]} is not a brand.json colour`);
          }
        }
        for (const m of value.matchAll(
          /(?<![\w-])(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi,
        )) {
          found.push(
            `colour function ${m[0]} is not allowed, use a brand.json hex or a var()`,
          );
        }
        for (const m of value.matchAll(/[A-Za-z0-9_-]+/g)) {
          if (named.has(m[0].toLowerCase())) {
            found.push(`named colour "${m[0]}" is not allowed`);
          }
        }
        if (/--(?:light|dark)-/.test(value)) {
          found.push(
            "a --light-* or --dark-* variable is not allowed, use the resolved --color-* token",
          );
        }
        for (const detail of found) {
          problems.push(fail("colours", path, `${property}: ${detail}`));
        }
      }
    }
    if (path.endsWith(".css"))
      problems.push(...tokenProblems(path, text, brand));
  }
  return problems;
};

/** The four `docs/assets/brand` files `--sync-brand` writes. */
export function brandFiles(
  brand: Brand,
  sources: BrandSources,
): Map<string, string> {
  const fill = 'fill="currentColor"';
  const count = sources.wordmark.split(fill).length - 1;
  if (count !== 1) {
    throw new Error(
      `the wordmark source must hold exactly one ${fill}, found ${count}`,
    );
  }
  const wordmark = (colour: string) =>
    sources.wordmark.replace(fill, () => `fill="${colour}"`);
  return new Map([
    [`${BRAND_DIR}mark.svg`, sources.mark],
    [`${BRAND_DIR}mark-dark.svg`, sources.markDark],
    [`${BRAND_DIR}wordmark-light.svg`, wordmark(brand.theme.light.text)],
    [`${BRAND_DIR}wordmark-dark.svg`, wordmark(brand.theme.dark.text)],
  ]);
}

export const brandProblems: Rule = (tree, brand, sources) => {
  if (!hasDocs(tree)) return [];
  const problems: string[] = [];
  for (const [path, want] of brandFiles(brand, sources)) {
    const got = tree.get(path);
    if (got === undefined) {
      problems.push(fail("brand", path, `missing, ${SYNC_HINT}`));
    } else if (decode(got) !== want) {
      problems.push(
        fail("brand", path, `differs from the brand sources, ${SYNC_HINT}`),
      );
    }
  }
  return problems;
};

/** The first `<nav>` of a page with `aria-current` removed and whitespace collapsed, also before a tag's closing `>` (a formatter may wrap `<a ...\n>Text</a\n>`). */
function navOf(text: string): string | null {
  const m = /<nav\b[^>]*>[\s\S]*?<\/nav>/i.exec(sourceText("x.html", text));
  if (m === null) return null;
  return m[0]
    .replace(/\s*aria-current="page"/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s+/g, " ")
    .replace(/ (\/?>)/g, "$1")
    .trim();
}

export const textProblems: Rule = (tree) => {
  const problems: string[] = [];
  for (const [path, text] of filesOf(tree, TEXT_FILE)) {
    const dash = text.indexOf(EM_DASH);
    if (dash >= 0) {
      const line = text.slice(0, dash).split("\n").length;
      problems.push(
        fail("text", path, `contains an em-dash (U+2014) at line ${line}`),
      );
    }
    for (const marker of PRIVATE_MARKERS) {
      if (text.includes(marker)) {
        problems.push(
          fail("text", path, `contains "${marker}" (private path or host)`),
        );
      }
    }
    for (const m of text.matchAll(PRIVATE_IP)) {
      problems.push(fail("text", path, `contains the private address ${m[0]}`));
    }
    if (!/\.(html|md)$/i.test(path)) continue;
    const src = sourceText(path, text);
    const alts: [string, string | undefined][] = htmlTags(src)
      .filter((t) => t.name === "img")
      .map((t): [string, string | undefined] => [
        t.attrs.get("src") ?? "",
        t.attrs.get("alt"),
      ]);
    if (path.endsWith(".md")) {
      for (const m of src.matchAll(MD_IMAGE)) alts.push([m[2], m[1]]);
    }
    for (const [url, alt] of alts) {
      const bare = url.split(/[?#]/)[0];
      if (alt === undefined) {
        problems.push(
          fail("text", path, `<img src="${url}"> has no alt attribute`),
        );
      } else if (alt.trim() === "" && !MARK_SRC.test(bare)) {
        problems.push(
          fail(
            "text",
            path,
            `image ${url} has an empty alt (only assets/brand/mark*.svg may)`,
          ),
        );
      }
    }
  }
  const pages = [...tree.keys()].filter((p) => PAGE.test(p)).sort();
  let reference: [string, string] | null = null;
  for (const path of pages) {
    const nav = navOf(decode(tree.get(path) ?? new Uint8Array()));
    if (nav === null) {
      problems.push(fail("text", path, "has no <nav>"));
    } else if (reference === null) {
      reference = [path, nav];
    } else if (nav !== reference[1]) {
      problems.push(
        fail("text", path, `<nav> differs from the <nav> of ${reference[0]}`),
      );
    }
  }
  return problems;
};

/** Chunk ids of a WebP, or why it is not one. */
function webpChunkIds(data: Uint8Array): string[] | string {
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...data.slice(from, to));
  if (data.length < 12 || ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WEBP") {
    return "does not start with RIFF and WEBP";
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (8 + view.getUint32(4, true) > data.length) {
    return "is shorter than its RIFF size";
  }
  const ids: string[] = [];
  let at = 12;
  while (at + 8 <= data.length) {
    const size = view.getUint32(at + 4, true);
    if (at + 8 + size > data.length)
      return "has a chunk past the end of the file";
    ids.push(ascii(at, at + 4));
    at += 8 + size + (size % 2);
  }
  return ids;
}

export const metadataProblems: Rule = (tree) => {
  const problems: string[] = [];
  for (const [path, data] of tree) {
    if (!path.startsWith(ASSETS) || !path.toLowerCase().endsWith(".webp")) {
      continue;
    }
    const ids = webpChunkIds(data);
    if (typeof ids === "string") {
      problems.push(fail("metadata", path, `is not a valid WebP: it ${ids}`));
      continue;
    }
    for (const id of ids.filter(
      (chunk) => chunk === "EXIF" || chunk === "XMP ",
    )) {
      problems.push(
        fail("metadata", path, `holds a ${id.trim()} chunk (strip metadata)`),
      );
    }
  }
  return problems;
};

/** All eight rules, in the order of the spec. */
export function docsProblems(
  tree: Tree,
  brand: Brand,
  sources: BrandSources,
): string[] {
  return [
    refsProblems,
    orphansProblems,
    budgetProblems,
    pairsProblems,
    coloursProblems,
    brandProblems,
    textProblems,
    metadataProblems,
  ].flatMap((rule) => rule(tree, brand, sources));
}

/** `README.md`, every file under `docs/` and the repository files the README links. */
export function loadTree(root: string): Tree {
  const tree: Tree = new Map();
  const add = (rel: string) => {
    tree.set(rel, new Uint8Array(readFileSync(join(root, rel))));
  };
  const walk = (rel: string) => {
    const dir = join(root, rel);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const child = `${rel}/${name}`;
      if (statSync(join(root, child)).isDirectory()) walk(child);
      else add(child);
    }
  };
  if (existsSync(join(root, "README.md"))) add("README.md");
  walk("docs");
  for (const [path, text] of filesOf(tree, /^README\.md$/)) {
    for (const ref of collectRefs(path, text)) {
      const res = resolveUrl(path, ref.url);
      if (
        res.kind === "local" &&
        !tree.has(res.path) &&
        existsSync(join(root, res.path)) &&
        statSync(join(root, res.path)).isFile()
      ) {
        add(res.path);
      }
    }
  }
  return tree;
}

/** The brand data the rules need, read from the repository. */
export function loadBrand(root: string): {
  brand: Brand;
  sources: BrandSources;
} {
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  return {
    brand: JSON.parse(read("brand.json")) as Brand,
    sources: {
      mark: read("brand/mark/vaakora-large.svg"),
      markDark: read("brand/mark/vaakora-large-dark.svg"),
      wordmark: read("brand/wordmark/vaakora-latin.svg"),
    },
  };
}

/** Write `files` (repo-relative paths) under `root`. */
export function writeBrandFiles(
  root: string,
  files: Map<string, string>,
): void {
  for (const [path, content] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), encoder.encode(content));
  }
}
