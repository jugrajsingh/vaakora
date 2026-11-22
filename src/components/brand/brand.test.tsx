import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { appName, brand, i18nInterpolation } from "@/lib/brand";
import en from "../../i18n/locales/en/translation.json";
import wordmark from "../../../brand/generated/wordmark-latin.json";
import { BrandLockup } from "./BrandLockup";
import { BrandMark } from "./BrandMark";
import { LinuxGuide } from "../onboarding/LinuxGuide";
import { SecureInputHelp } from "../SecureInputWarning";

const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => void) => void;
} = createRequire(import.meta.url)("bun:test");

const i18n = i18next.createInstance();
await i18n.init({
  lng: "en",
  resources: { en: { translation: en } },
  interpolation: i18nInterpolation,
});

const render = (node: React.ReactElement) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("BrandLockup", () => {
  it("lockup_names_vaakora", () => {
    const html = render(<BrandLockup size={26} />);
    assert.equal(appName, "Vaakora");
    assert.ok(html.includes('aria-label="Vaakora"'), "the group is named");
    // The 26 px lockup uses the 16 master (rects only), so every <path is a glyph.
    assert.equal(count(html, "<path"), wordmark.paths.length);
    assert.ok(/class="[^"]*text-wordmark/.test(html), "word colour class");
    assert.ok(html.includes('fill="currentColor"'));
    assert.ok(count(html, 'aria-hidden="true"') >= 2, "mark and word hidden");
  });

  it("sizes the word from the svg viewBox, cap height 0.537 of the mark", () => {
    const [x, y, w, h] = wordmark.viewBox.split(" ").map(Number);
    assert.equal(x, 0);
    assert.ok(y < 0, "the Latin viewBox starts above the baseline");
    const size = 40;
    const html = render(<BrandLockup size={size} />);
    const scale = (size * 0.537) / wordmark.cap;
    assert.ok(
      html.includes(`viewBox="${wordmark.viewBox}"`),
      "viewBox is read",
    );
    assert.ok(html.includes(`width="${(w * scale).toFixed(2)}"`), "word width");
    assert.ok(
      html.includes(`height="${(h * scale).toFixed(2)}"`),
      "word height",
    );
    assert.ok(
      html.includes(`gap:${size / 4}px`),
      "gap is a quarter of the mark",
    );
  });
});

describe("BrandMark", () => {
  it("mark_picks_the_master_by_size", () => {
    const rects = [
      'x="10" y="2" width="2" height="12"',
      'x="8" y="2" width="6" height="2"',
      'x="8" y="12" width="6" height="2"',
      'x="2" y="6" width="2" height="4"',
      'x="5" y="3" width="2" height="10"',
    ];
    for (const size of [16, 32]) {
      const html = render(<BrandMark size={size} />);
      assert.ok(html.includes('viewBox="0 0 16 16"'), `${size}: 16 master`);
      assert.ok(html.includes(`width="${size}"`), `${size}: width`);
      for (const rect of rects)
        assert.ok(html.includes(rect), `${size}: ${rect}`);
    }
    assert.ok(render(<BrandMark size={22} />).includes('viewBox="0 0 22 22"'));
    assert.ok(render(<BrandMark size={24} />).includes('viewBox="0 0 24 24"'));
    const large = render(<BrandMark size={64} />);
    assert.ok(large.includes('viewBox="0 0 1024 1024"'));
    assert.ok(large.includes("<path"));
  });

  it("takes its colours from brand.json and keylines with a token", () => {
    for (const size of [16, 64]) {
      const html = render(<BrandMark size={size} className="x" />);
      for (const c of [brand.mark.tile, brand.mark.bars, brand.mark.cursor]) {
        assert.ok(html.includes(c), `${size}: ${c}`);
      }
      assert.ok(html.includes("var(--color-mark-keyline"), `${size}: token`);
      assert.ok(!html.includes(brand.mark.keyline), `${size}: no literal`);
      assert.ok(html.includes('role="img"'));
      assert.ok(html.includes('aria-label="Vaakora"'));
      assert.ok(html.includes('class="x"'));
    }
  });
});

describe("documentation links", () => {
  it("render only when the brand has a docs site", () => {
    assert.equal(brand.links.docs, null, "brand.json has no docs site yet");
    assert.equal(render(<SecureInputHelp url={null} />), "");
    const help = render(<SecureInputHelp url="https://docs.example.test" />);
    assert.ok(help.includes("<button"));
    assert.ok(help.includes("focus:outline-none"));
    assert.ok(help.includes("focus-visible:ring-2"));
    assert.ok(help.includes("focus-visible:ring-logo-primary"));
  });

  it("LinuxGuide keeps its sentence without a link", () => {
    const view = (docsUrl: string | null) =>
      render(<LinuxGuide i18nKey="onboarding.linux.tryIt" docsUrl={docsUrl} />);
    const sentence = en.onboarding.linux.tryIt.replace(/<\/?guide>/g, "");
    const without = view(null);
    assert.ok(!without.includes("<button"), "no link without docs");
    assert.ok(
      without.replace(/<[^>]*>/g, "").includes(sentence.slice(0, 20)),
      "the sentence stays",
    );
    const withLink = view("https://docs.example.test");
    assert.ok(withLink.includes("<button"));
    assert.ok(
      withLink.includes("focus-visible:ring-2 focus-visible:ring-logo-primary"),
    );
  });
});
