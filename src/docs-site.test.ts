import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  brandFiles,
  brandProblems,
  budgetProblems,
  coloursProblems,
  docsProblems,
  LIMITS,
  loadTree,
  metadataProblems,
  NAMED_COLOURS,
  orphansProblems,
  pairsProblems,
  refsProblems,
  textProblems,
  writeBrandFiles,
  type Brand,
  type BrandSources,
  type Tree,
} from "../scripts/docs-check";

const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (path: string) =>
  readFileSync(resolvePath(ROOT, path), "utf8");
const BRAND = JSON.parse(readText("brand.json")) as Brand;
const SOURCES: BrandSources = {
  mark: readText("brand/mark/vaakora-large.svg"),
  markDark: readText("brand/mark/vaakora-large-dark.svg"),
  wordmark: readText("brand/wordmark/vaakora-latin.svg"),
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (text: string) => enc.encode(text);
const EM_DASH = String.fromCharCode(0x2014);
const RULES = [
  "refs",
  "orphans",
  "budget",
  "pairs",
  "colours",
  "brand",
  "text",
  "metadata",
];

/** A WebP-shaped file of exactly `total` bytes: RIFF header and one VP8L chunk. */
function webp(total: number): Uint8Array {
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(bytes("RIFF"), 0);
  view.setUint32(4, total - 8, true);
  out.set(bytes("WEBP"), 8);
  out.set(bytes("VP8L"), 12);
  view.setUint32(16, total - 20, true);
  return out;
}

/** A WebP with the given chunks: `[id, payload length]`, each padded to even. */
function webpChunks(chunks: [string, number][]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [id, size] of chunks) {
    const chunk = new Uint8Array(8 + size + (size % 2));
    chunk.set(bytes(id), 0);
    new DataView(chunk.buffer).setUint32(4, size, true);
    parts.push(chunk);
  }
  const body = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(12 + body);
  out.set(bytes("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, 4 + body, true);
  out.set(bytes("WEBP"), 8);
  let at = 12;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const NAV = `<nav>
  <a href="index.html" aria-current="page">Overview</a>
</nav>`;

const picture = (light: string, dark: string, alt: string) =>
  `<picture><source media="(prefers-color-scheme: dark)" srcset="${dark}"><img src="${light}" alt="${alt}"></picture>`;

function page(body: string, nav = NAV): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Vaakora</title>
    <link rel="stylesheet" href="assets/site.css" />
  </head>
  <body>
    <header>
      ${picture("assets/brand/mark.svg", "assets/brand/mark-dark.svg", "")}
      ${picture("assets/brand/wordmark-light.svg", "assets/brand/wordmark-dark.svg", "Vaakora")}
      ${nav}
    </header>
    <main>
      <h1>Vaakora</h1>
      ${body}
    </main>
  </body>
</html>
`;
}

const tokens = (theme: "light" | "dark") =>
  ["text", "background", "surface"]
    .map((t) => `--color-${t}: ${BRAND.theme[theme][t]};`)
    .join("\n    ");

const CSS = `:root {
  color-scheme: light dark;
  ${tokens("light")}
}

@media (prefers-color-scheme: dark) {
  :root {
    ${tokens("dark")}
  }
}

body {
  color: var(--color-text);
  background: var(--color-background);
}
`;

const README = `# Vaakora

![licence: MIT](https://img.shields.io/badge/licence-MIT-376b43)

The [docs](docs/index.html) have a page per feature.
`;

/** A tree that passes every rule: one page, the stylesheet, the brand files, one light and dark still, a README. */
function clean(): Tree {
  const tree: Tree = new Map();
  tree.set("README.md", bytes(README));
  tree.set(
    "docs/index.html",
    bytes(
      page(
        picture(
          "assets/screens/dictation-light.webp",
          "assets/screens/dictation-dark.webp",
          "The Vaakora window",
        ),
      ),
    ),
  );
  tree.set("docs/assets/site.css", bytes(CSS));
  for (const [path, content] of brandFiles(BRAND, SOURCES)) {
    tree.set(path, bytes(content));
  }
  tree.set("docs/assets/screens/dictation-light.webp", webp(2000));
  tree.set("docs/assets/screens/dictation-dark.webp", webp(2000));
  return tree;
}

const textOf = (tree: Tree, path: string) => {
  const file = tree.get(path);
  assert.ok(file, `fixture has no ${path}`);
  return dec.decode(file);
};

/** Replace `from` (which must occur) with `to` in one fixture file. */
function edit(tree: Tree, path: string, from: string, to: string): Tree {
  const text = textOf(tree, path);
  assert.ok(text.includes(from), `${path} has no "${from}"`);
  tree.set(path, bytes(text.replace(from, () => to)));
  return tree;
}

const append = (tree: Tree, path: string, text: string): Tree =>
  tree.set(path, bytes(textOf(tree, path) + text));

/** Add markup inside `<main>` of the index page. */
const addToPage = (tree: Tree, html: string): Tree =>
  edit(tree, "docs/index.html", "</main>", `${html}\n</main>`);

const all = (tree: Tree) => docsProblems(tree, BRAND, SOURCES);

/** Assert that some problem is `FAIL <rule>: ` and mentions `needle`. */
function flags(tree: Tree, rule: string, needle: string): void {
  const problems = all(tree);
  assert.ok(
    problems.some((p) => p.startsWith(`FAIL ${rule}: `) && p.includes(needle)),
    `want FAIL ${rule} mentioning "${needle}", got ${JSON.stringify(problems)}`,
  );
}

/** Assert that the one and only problem is `FAIL <rule>: ` and mentions `needle` (no other branch or rule helps). */
function flagsOnly(tree: Tree, rule: string, needle: string): void {
  const problems = all(tree);
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.ok(
    problems[0].startsWith(`FAIL ${rule}: `) && problems[0].includes(needle),
    `want FAIL ${rule} mentioning "${needle}", got ${problems[0]}`,
  );
}

const passes = (tree: Tree) => assert.deepEqual(all(tree), []);

/** `#rrggbb` with its last digit changed. */
const nudge = (hex: string) =>
  hex.slice(0, -1) + (hex.endsWith("0") ? "1" : "0");

const assetBytes = (tree: Tree) =>
  [...tree]
    .filter(([path]) => path.startsWith("docs/assets/"))
    .reduce((sum, [, content]) => sum + content.length, 0);

describe("docs checker", () => {
  it("clean_fixture_passes", () => {
    passes(clean());
  });

  it("docs_problems_runs_the_eight_rules_in_order", () => {
    const tree = clean();
    addToPage(tree, `<img src="assets/missing.webp" alt="x">`);
    append(tree, "docs/assets/site.css", "a { color: #ff0000; }\n");
    append(tree, "README.md", `A dash ${EM_DASH} here.\n`);
    tree.set("docs/assets/screens/lonely-light.webp", webp(2000));
    tree.set("docs/assets/big.png", new Uint8Array(4));
    tree.set(
      "docs/assets/screens/dictation-light.webp",
      webpChunks([["EXIF", 4]]),
    );
    const rules = [
      refsProblems,
      orphansProblems,
      budgetProblems,
      pairsProblems,
      coloursProblems,
      brandProblems,
      textProblems,
      metadataProblems,
    ];
    const want = rules.flatMap((rule) => rule(tree, BRAND, SOURCES));
    assert.deepEqual(all(tree), want);
    const seen = want.map((p) => RULES.indexOf(p.split(":")[0].slice(5)));
    assert.ok(!seen.includes(-1), JSON.stringify(want));
    assert.deepEqual(
      [...new Set(seen)],
      [0, 1, 2, 3, 4, 6, 7],
      "refs, orphans, budget, pairs, colours, text and metadata each reported, in order",
    );
    assert.deepEqual(
      seen,
      [...seen].sort((a, b) => a - b),
    );
  });

  describe("refs", () => {
    it("refs_flags_a_missing_image", () => {
      flags(
        addToPage(clean(), `<img src="assets/missing.webp" alt="x">`),
        "refs",
        "docs/assets/missing.webp",
      );
    });

    it("refs_flags_a_link_leaving_docs", () => {
      flagsOnly(
        addToPage(clean(), `<a href="../README.md">Readme</a>`),
        "refs",
        "leaves docs/",
      );
    });

    it("refs_flags_a_link_leaving_the_repository", () => {
      flagsOnly(
        append(clean(), "README.md", "\nSee [x](../outside.md).\n"),
        "refs",
        "leaves the repository",
      );
    });

    it("refs_flags_a_link_with_an_unsupported_scheme", () => {
      flagsOnly(
        addToPage(clean(), `<a href="javascript:void(0)">Run</a>`),
        "refs",
        "uses a scheme the docs do not allow",
      );
      flagsOnly(
        addToPage(clean(), `<a href="ftp://example.com/x">Files</a>`),
        "refs",
        "uses a scheme the docs do not allow",
      );
    });

    it("refs_flags_a_missing_anchor", () => {
      flags(
        addToPage(clean(), `<a href="index.html#nope">Nope</a>`),
        "refs",
        "#nope",
      );
      flags(addToPage(clean(), `<a href="#nope">Nope</a>`), "refs", "#nope");
    });

    it("refs_allows_an_anchor_that_exists", () => {
      passes(
        addToPage(
          clean(),
          `<h2 id="intro">Intro</h2><a href="#intro">Intro</a><a href="index.html#intro">Intro</a><a href="#">Top</a>`,
        ),
      );
    });

    it("refs_resolves_links_to_the_published_site_against_docs", () => {
      const withId = addToPage(clean(), `<h2 id="intro">Intro</h2>`);
      passes(
        append(
          withId,
          "README.md",
          "\nSee [site](https://vaakora.jugraj.dev/), [page](https://vaakora.jugraj.dev/index.html) and [part](https://vaakora.jugraj.dev/index.html#intro).\n",
        ),
      );
      flags(
        append(
          clean(),
          "README.md",
          "\nSee [x](https://vaakora.jugraj.dev/missing.html).\n",
        ),
        "refs",
        "https://vaakora.jugraj.dev/missing.html does not exist (docs/missing.html)",
      );
      flags(
        append(
          clean(),
          "README.md",
          "\nSee [x](https://vaakora.jugraj.dev/index.html#nope).\n",
        ),
        "refs",
        "#nope",
      );
    });

    it("refs_keeps_site_assets_and_directories_external", () => {
      flags(
        addToPage(
          clean(),
          `<img src="https://vaakora.jugraj.dev/assets/brand/mark.svg" alt="x">`,
        ),
        "refs",
        "https://vaakora.jugraj.dev/assets/brand/mark.svg is external",
      );
      flags(
        append(
          clean(),
          "README.md",
          "\n![x](https://vaakora.jugraj.dev/assets/brand/mark.svg)\n",
        ),
        "refs",
        "https://vaakora.jugraj.dev/assets/brand/mark.svg is external",
      );
      // Not a page link, so it is not resolved against docs/ (that would fail: docs/nowhere does not exist).
      passes(
        addToPage(
          clean(),
          `<a href="https://vaakora.jugraj.dev/assets/">Assets</a><a href="https://vaakora.jugraj.dev/nowhere/">Nowhere</a>`,
        ),
      );
    });

    it("refs_leaves_other_hosts_external", () => {
      passes(
        append(
          clean(),
          "README.md",
          "\nSee [x](https://example.com/missing.html).\n",
        ),
      );
    });

    it("refs_allows_shields_only_in_readme", () => {
      passes(clean());
      flags(
        addToPage(
          clean(),
          `<img src="https://img.shields.io/badge/licence-MIT-376b43" alt="MIT">`,
        ),
        "refs",
        "https://img.shields.io/badge/",
      );
      flags(
        append(clean(), "README.md", "\n![x](https://example.com/x.png)\n"),
        "refs",
        "https://example.com/x.png",
      );
    });

    it("refs_flags_a_missing_markdown_link_and_image", () => {
      flags(
        append(clean(), "README.md", "\nSee [the log](CHANGELOG.md).\n"),
        "refs",
        "CHANGELOG.md",
      );
      flags(
        append(clean(), "README.md", "\n![shot](docs/assets/none.webp)\n"),
        "refs",
        "docs/assets/none.webp",
      );
    });

    it("refs_ignores_links_and_images_inside_code", () => {
      passes(
        append(
          clean(),
          "README.md",
          "\nUse `[a](missing.md)` or\n\n```\n![x](missing.png)\n```\n",
        ),
      );
    });

    it("refs_checks_every_srcset_candidate", () => {
      flags(
        addToPage(
          clean(),
          `<picture><source srcset="assets/screens/dictation-dark.webp 1x, assets/screens/none.webp 2x"><img src="assets/screens/dictation-dark.webp" alt="x"></picture>`,
        ),
        "refs",
        "docs/assets/screens/none.webp",
      );
    });

    it("refs_checks_css_url_relative_to_the_stylesheet", () => {
      flags(
        append(
          clean(),
          "docs/assets/site.css",
          "a { background: url(missing.webp); }\n",
        ),
        "refs",
        "docs/assets/missing.webp",
      );
      passes(
        append(
          clean(),
          "docs/assets/site.css",
          "a { background: url(screens/dictation-dark.webp); }\n",
        ),
      );
    });

    it("refs_skips_outbound_anchors_and_mailto", () => {
      passes(
        addToPage(
          clean(),
          `<a href="https://github.com/cjpais/Handy">Handy</a><a href="mailto:a@b.example">Mail</a>`,
        ),
      );
    });

    it("refs_flags_an_absolute_path_and_an_external_stylesheet", () => {
      flags(
        addToPage(clean(), `<a href="/index.html">Home</a>`),
        "refs",
        "/index.html",
      );
      flags(
        addToPage(
          clean(),
          `<link rel="stylesheet" href="https://example.com/a.css">`,
        ),
        "refs",
        "https://example.com/a.css",
      );
    });
  });

  describe("orphans", () => {
    it("orphans_flags_an_unreferenced_asset", () => {
      const tree = clean();
      tree.set("docs/assets/screens/extra-light.webp", webp(2000));
      tree.set("docs/assets/screens/extra-dark.webp", webp(2000));
      flags(tree, "orphans", "docs/assets/screens/extra-light.webp");
    });

    it("orphans_counts_a_stylesheet_reference", () => {
      const tree = clean();
      tree.set("docs/assets/bg.svg", bytes("<svg></svg>"));
      flags(tree, "orphans", "docs/assets/bg.svg");
      append(tree, "docs/assets/site.css", "a { background: url(bg.svg); }\n");
      passes(tree);
    });
  });

  describe("budget", () => {
    it("budget_flags_a_still_over_100_kib", () => {
      const tree = clean();
      tree.set("docs/assets/screens/dictation-light.webp", webp(LIMITS.still));
      passes(tree);
      tree.set(
        "docs/assets/screens/dictation-light.webp",
        webp(LIMITS.still + 1),
      );
      flags(tree, "budget", "docs/assets/screens/dictation-light.webp");
    });

    it("budget_flags_a_clip_over_800_kib", () => {
      const tree = addToPage(
        clean(),
        `<img src="assets/clips/dictate.webp" alt="Dictation">`,
      );
      tree.set("docs/assets/clips/dictate.webp", webp(LIMITS.clip));
      passes(tree);
      tree.set("docs/assets/clips/dictate.webp", webp(LIMITS.clip + 1));
      flags(tree, "budget", "docs/assets/clips/dictate.webp");
    });

    it("budget_flags_an_svg_over_32_kib", () => {
      const tree = addToPage(
        clean(),
        `<img src="assets/big.svg" alt="Diagram">`,
      );
      const svg = (size: number) =>
        bytes("<svg>" + " ".repeat(size - 11) + "</svg>");
      tree.set("docs/assets/big.svg", svg(LIMITS.svg));
      passes(tree);
      tree.set("docs/assets/big.svg", svg(LIMITS.svg + 1));
      flags(tree, "budget", "docs/assets/big.svg");
    });

    it("budget_flags_a_png_under_assets", () => {
      const tree = addToPage(
        clean(),
        `<img src="assets/screens/x.png" alt="x">`,
      );
      tree.set("docs/assets/screens/x.png", new Uint8Array(10));
      flags(tree, "budget", "docs/assets/screens/x.png");
    });

    it("budget_flags_a_total_over_3_mib", () => {
      const tree = clean();
      for (const name of ["a", "b", "c"]) {
        tree.set(`docs/assets/clips/${name}.webp`, webp(LIMITS.clip));
      }
      const last = "docs/assets/clips/d.webp";
      const room = LIMITS.total - assetBytes(tree);
      assert.ok(room > 0 && room <= LIMITS.clip, "fixture sizes are off");
      tree.set(last, webp(room));
      assert.equal(assetBytes(tree), LIMITS.total);
      assert.deepEqual(budgetProblems(tree, BRAND, SOURCES), []);
      tree.set(last, webp(room + 2));
      flags(tree, "budget", "total");
    });
  });

  describe("pairs", () => {
    it("pairs_flags_a_light_without_dark", () => {
      const noDark = clean();
      noDark.delete("docs/assets/screens/dictation-dark.webp");
      flags(noDark, "pairs", "docs/assets/screens/dictation-dark.webp");
      const noLight = clean();
      noLight.delete("docs/assets/screens/dictation-light.webp");
      flags(noLight, "pairs", "docs/assets/screens/dictation-light.webp");
    });

    it("pairs_flags_a_picture_without_its_dark_twin", () => {
      const wrongSource = edit(
        clean(),
        "docs/index.html",
        'srcset="assets/screens/dictation-dark.webp"',
        'srcset="assets/screens/dictation-light.webp"',
      );
      flags(wrongSource, "pairs", "docs/assets/screens/dictation-light.webp");
      const bare = addToPage(
        clean(),
        `<img src="assets/screens/dictation-light.webp" alt="The Vaakora window">`,
      );
      flags(bare, "pairs", "docs/assets/screens/dictation-light.webp");
    });

    it("pairs_flags_a_dark_source_without_the_dark_media_query", () => {
      flags(
        edit(
          clean(),
          "docs/index.html",
          'media="(prefers-color-scheme: dark)" srcset="assets/screens/dictation-dark.webp"',
          'srcset="assets/screens/dictation-dark.webp"',
        ),
        "pairs",
        "prefers-color-scheme: dark",
      );
    });

    it("pairs_flags_a_markdown_image_of_a_light_screen", () => {
      flags(
        append(
          clean(),
          "README.md",
          "\n![shot](docs/assets/screens/dictation-light.webp)\n",
        ),
        "pairs",
        "docs/assets/screens/dictation-light.webp",
      );
    });

    it("pairs_accepts_a_readme_picture", () => {
      passes(
        append(
          clean(),
          "README.md",
          `\n${picture(
            "docs/assets/screens/dictation-light.webp",
            "docs/assets/screens/dictation-dark.webp",
            "The window",
          )}\n`,
        ),
      );
    });
  });

  describe("colours", () => {
    const css = (tree: Tree, rule: string) =>
      append(tree, "docs/assets/site.css", `${rule}\n`);

    it("colours_flags_a_hex_not_in_brand", () => {
      flags(css(clean(), "a { color: #ff0000; }"), "colours", "#ff0000");
      flags(css(clean(), "a { color: #f00; }"), "colours", "#f00");
      flags(css(clean(), "a { color: #ff000080; }"), "colours", "#ff000080");
      const light = BRAND.theme.light.text;
      flags(
        edit(
          clean(),
          "docs/assets/site.css",
          `--color-text: ${light};`,
          `--color-text: ${nudge(light)};`,
        ),
        "colours",
        `colour ${nudge(light)} is not a brand.json colour`,
      );
    });

    it("colours_flags_a_named_colour", () => {
      flags(css(clean(), "a { color: red; }"), "colours", '"red"');
      flags(
        css(clean(), "a { border: 1px solid Tomato; }"),
        "colours",
        '"Tomato"',
      );
    });

    it("colours_knows_the_148_named_colours", () => {
      assert.equal(NAMED_COLOURS.length, 148);
      assert.equal(new Set(NAMED_COLOURS).size, 148);
      for (const name of [
        "rebeccapurple",
        "lightgoldenrodyellow",
        "darkgrey",
      ]) {
        assert.ok(NAMED_COLOURS.includes(name), name);
      }
      for (const name of NAMED_COLOURS) {
        flags(css(clean(), `a { color: ${name}; }`), "colours", `"${name}"`);
      }
    });

    it("colours_flags_a_functional_colour", () => {
      for (const literal of [
        "rgb(0 0 0)",
        "rgba(0, 0, 0, 0.5)",
        "hsl(10 20% 30%)",
        "hsla(10, 20%, 30%, 0.5)",
        "oklch(0.5 0.1 120)",
      ]) {
        flags(
          css(clean(), `a { color: ${literal}; }`),
          "colours",
          literal.slice(0, literal.indexOf("(") + 1),
        );
      }
    });

    it("colours_flags_a_literal_inside_color_mix", () => {
      flags(
        css(
          clean(),
          "a { background: color-mix(in srgb, #ff0000 5%, var(--color-surface)); }",
        ),
        "colours",
        "#ff0000",
      );
      flags(
        css(
          clean(),
          "a { background: color-mix(in srgb, red 5%, var(--color-surface)); }",
        ),
        "colours",
        '"red"',
      );
      passes(
        css(
          clean(),
          "a { background: color-mix(in srgb, var(--color-text) 5%, var(--color-surface)); }",
        ),
      );
    });

    it("colours_flags_a_token_that_differs_from_brand", () => {
      // A different colour that brand.json does have, so only the token/theme
      // equality check can object (the palette check accepts it).
      const { light, dark } = BRAND.theme;
      assert.notEqual(light.surface, light.text);
      assert.notEqual(dark.surface, dark.text);
      flagsOnly(
        edit(
          clean(),
          "docs/assets/site.css",
          `--color-text: ${light.text};`,
          `--color-text: ${light.surface};`,
        ),
        "colours",
        `brand.theme.light.text is ${light.text}`,
      );
      flagsOnly(
        edit(
          clean(),
          "docs/assets/site.css",
          `--color-text: ${dark.text};`,
          `--color-text: ${dark.surface};`,
        ),
        "colours",
        `brand.theme.dark.text is ${dark.text}`,
      );
    });

    it("colours_flags_a_token_brand_does_not_have", () => {
      flags(
        edit(
          clean(),
          "docs/assets/site.css",
          "color-scheme: light dark;",
          "color-scheme: light dark;\n  --color-nope: #376b43;",
        ),
        "colours",
        "--color-nope",
      );
    });

    it("colours_flags_an_inline_style", () => {
      flags(
        addToPage(clean(), `<p style="color: #ff0000">x</p>`),
        "colours",
        "#ff0000",
      );
      flags(
        addToPage(clean(), `<p style='background: blue'>x</p>`),
        "colours",
        "blue",
      );
      flags(
        addToPage(clean(), `<style>p { color: #ff0000; }</style>`),
        "colours",
        "#ff0000",
      );
    });

    it("colours_flags_a_light_or_dark_variable", () => {
      flags(
        css(clean(), "a { color: var(--light-color-text); }"),
        "colours",
        "--light-",
      );
      flags(
        addToPage(clean(), `<p style="color: var(--dark-color-text)">x</p>`),
        "colours",
        "--dark-",
      );
    });

    it("colours_allows_brand_hex_and_var", () => {
      const tree = css(
        clean(),
        `a { color: ${BRAND.mark.cursor.toUpperCase()}; border-color: ${BRAND.theme.light["logo-primary"]}; background: transparent; fill: currentColor; stroke: inherit; outline: 1px solid var(--color-line); }`,
      );
      addToPage(
        tree,
        `<p style="color: var(--color-text); background: ${BRAND.theme.light.surface}">x</p>`,
      );
      passes(tree);
    });

    it("colours_ignores_selectors_and_urls_that_look_like_colours", () => {
      passes(
        css(
          clean(),
          '.red { color: var(--color-text); }\n#fade { margin: 0; }\na:not(.blue):hover { color: var(--color-text); }\nsvg { filter: url(#bad); }\nb::before { content: "red"; }',
        ),
      );
    });
  });

  describe("brand", () => {
    it("brand_files_follow_the_sources_and_theme", () => {
      const files = brandFiles(BRAND, SOURCES);
      assert.deepEqual([...files.keys()].sort(), [
        "docs/assets/brand/mark-dark.svg",
        "docs/assets/brand/mark.svg",
        "docs/assets/brand/wordmark-dark.svg",
        "docs/assets/brand/wordmark-light.svg",
      ]);
      assert.equal(files.get("docs/assets/brand/mark.svg"), SOURCES.mark);
      assert.equal(
        files.get("docs/assets/brand/mark-dark.svg"),
        SOURCES.markDark,
      );
      const light = files.get("docs/assets/brand/wordmark-light.svg") ?? "";
      const dark = files.get("docs/assets/brand/wordmark-dark.svg") ?? "";
      assert.ok(light.includes(`fill="${BRAND.theme.light.text}"`));
      assert.ok(dark.includes(`fill="${BRAND.theme.dark.text}"`));
      assert.ok(!light.includes("currentColor"));
      assert.equal(
        light.replace(
          `fill="${BRAND.theme.light.text}"`,
          'fill="currentColor"',
        ),
        SOURCES.wordmark,
      );
    });

    it("brand_files_refuse_a_wordmark_without_exactly_one_fill", () => {
      assert.throws(
        () => brandFiles(BRAND, { ...SOURCES, wordmark: "<svg></svg>" }),
        /currentColor/,
      );
    });

    it("brand_flags_a_stale_wordmark", () => {
      const tree = clean();
      edit(
        tree,
        "docs/assets/brand/wordmark-light.svg",
        `fill="${BRAND.theme.light.text}"`,
        `fill="${nudge(BRAND.theme.light.text)}"`,
      );
      flags(
        tree,
        "brand",
        "wordmark-light.svg: differs from the brand sources",
      );
    });

    it("brand_flags_a_missing_brand_file", () => {
      const tree = clean();
      tree.delete("docs/assets/brand/mark-dark.svg");
      flags(tree, "brand", "mark-dark.svg: missing");
    });

    it("brand_is_not_checked_before_docs_exist", () => {
      const tree: Tree = new Map([["README.md", bytes("# Vaakora\n")]]);
      assert.deepEqual(brandProblems(tree, BRAND, SOURCES), []);
      assert.deepEqual(all(tree), []);
    });
  });

  describe("text", () => {
    it("text_flags_an_em_dash", () => {
      flags(
        addToPage(clean(), `<p>One ${EM_DASH} two</p>`),
        "text",
        "docs/index.html",
      );
      flags(
        append(clean(), "README.md", `\nOne ${EM_DASH} two\n`),
        "text",
        "README.md",
      );
    });

    it("text_flags_a_home_path", () => {
      for (const [sample, marker] of [
        ["/home/someone/notes", "/home/"],
        ["/run/user/1000/x.sock", "/run/user/"],
        ["/Users/someone/notes", "/Users/"],
        [".superpowers/logs", ".superpowers"],
        [".scratch/vaakora", ".scratch"],
        [".worktrees/vaakora", ".worktrees"],
        ["http://localhost:3000", "localhost"],
        ["127.0.0.1", "127.0.0.1"],
      ]) {
        flags(addToPage(clean(), `<p>${sample}</p>`), "text", `"${marker}"`);
      }
    });

    it("text_flags_a_private_ip", () => {
      for (const ip of [
        "192.168.1.20",
        "10.0.0.5",
        "172.16.0.1",
        "172.31.255.255",
      ]) {
        flags(addToPage(clean(), `<p>host ${ip}</p>`), "text", ip);
      }
    });

    it("text_allows_versions_and_public_addresses", () => {
      passes(
        addToPage(
          clean(),
          `<p>Based on Handy v0.10.1, build 1.10.1.1, resolver 8.8.8.8, 172.32.0.1</p>`,
        ),
      );
    });

    it("text_flags_an_img_without_alt", () => {
      flags(
        addToPage(clean(), `<img src="assets/screens/dictation-dark.webp">`),
        "text",
        "has no alt attribute",
      );
      flags(
        append(
          clean(),
          "README.md",
          `\n<img src="docs/assets/screens/dictation-dark.webp">\n`,
        ),
        "text",
        "has no alt attribute",
      );
    });

    it("text_flags_an_empty_alt_except_on_the_mark", () => {
      flags(
        addToPage(
          clean(),
          `<img src="assets/screens/dictation-dark.webp" alt="">`,
        ),
        "text",
        "has an empty alt",
      );
      flags(
        addToPage(clean(), `<img src="assets/brand/wordmark-dark.svg" alt="">`),
        "text",
        "has an empty alt",
      );
      flags(
        append(
          clean(),
          "README.md",
          "\n![](docs/assets/screens/dictation-dark.webp)\n",
        ),
        "text",
        "has an empty alt",
      );
      passes(
        addToPage(
          clean(),
          `<img src="assets/brand/mark.svg" alt=""><img src="assets/brand/mark-dark.svg" alt="">`,
        ),
      );
    });

    it("text_flags_a_nav_that_differs", () => {
      const tree = clean();
      tree.set(
        "docs/other.html",
        bytes(
          page(
            "<p>Other</p>",
            `<nav><a href="index.html">Overview</a> <a href="other.html" aria-current="page">Other</a></nav>`,
          ),
        ),
      );
      flags(
        tree,
        "text",
        "docs/other.html: <nav> differs from the <nav> of docs/index.html",
      );
    });

    it("text_ignores_current_page_and_whitespace_in_the_nav", () => {
      const tree = clean();
      tree.set(
        "docs/other.html",
        bytes(
          page(
            "<p>Other</p>",
            `<nav><a   href="index.html">Overview</a></nav>`,
          ),
        ),
      );
      passes(tree);
    });

    it("text_ignores_a_formatter_wrapped_nav_link", () => {
      const tree = clean();
      tree.set(
        "docs/other.html",
        bytes(
          page(
            "<p>Other</p>",
            `<nav>
  <a href="index.html" aria-current="page"
    >Overview</a
  >
</nav>`,
          ),
        ),
      );
      passes(tree);
    });

    it("text_flags_a_page_without_a_nav", () => {
      const tree = clean();
      tree.set("docs/other.html", bytes(page("<p>Other</p>", "")));
      flagsOnly(tree, "text", "docs/other.html: has no <nav>");
    });
  });

  describe("metadata", () => {
    const withShot = (file: Uint8Array) => {
      const tree = clean();
      tree.set("docs/assets/screens/dictation-light.webp", file);
      return tree;
    };

    it("metadata_flags_exif_in_webp", () => {
      flags(
        withShot(
          webpChunks([
            ["VP8L", 101],
            ["EXIF", 20],
          ]),
        ),
        "metadata",
        "EXIF",
      );
      flags(
        withShot(
          webpChunks([
            ["VP8X", 10],
            ["XMP ", 7],
          ]),
        ),
        "metadata",
        "XMP",
      );
    });

    it("metadata_allows_other_chunks", () => {
      passes(
        withShot(
          webpChunks([
            ["VP8X", 10],
            ["ICCP", 5],
            ["VP8L", 33],
          ]),
        ),
      );
    });

    it("metadata_flags_a_file_that_is_not_webp", () => {
      flagsOnly(
        withShot(bytes("not an image at all")),
        "metadata",
        "is not a valid WebP: it does not start with RIFF and WEBP",
      );
      const valid = webpChunks([["VP8L", 40]]);
      flagsOnly(
        withShot(valid.slice(0, 30)),
        "metadata",
        "is not a valid WebP: it is shorter than its RIFF size",
      );
      const longChunk = valid.slice();
      new DataView(longChunk.buffer).setUint32(16, 1000, true);
      flagsOnly(
        withShot(longChunk),
        "metadata",
        "is not a valid WebP: it has a chunk past the end of the file",
      );
    });
  });

  describe("tree and command", () => {
    it("real_tree_passes", () => {
      assert.deepEqual(docsProblems(loadTree(ROOT), BRAND, SOURCES), []);
    });

    it("load_tree_holds_the_readme_and_what_it_links", () => {
      const tree = loadTree(ROOT);
      assert.ok(tree.has("README.md"));
      assert.ok(tree.has("CHANGELOG.md"), "README links CHANGELOG.md");
      for (const path of tree.keys()) {
        assert.ok(!path.includes("\\") && !path.startsWith("/"), path);
      }
    });

    it("write_brand_files_writes_the_four_files", () => {
      const dir = mkdtempSync(join(tmpdir(), "docs-sync-"));
      try {
        const files = brandFiles(BRAND, SOURCES);
        writeBrandFiles(dir, files);
        for (const [path, content] of files) {
          assert.equal(readFileSync(join(dir, path), "utf8"), content);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("cli_prints_docs_pass_on_the_real_tree", () => {
      const run = spawnSync(
        process.execPath,
        [resolvePath(ROOT, "scripts/check-docs.ts")],
        { encoding: "utf8" },
      );
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal(run.stdout.trim(), "DOCS PASS");
    });
  });
});
