import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { appName, brand } from "./brand";

const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, "..", "..");
const read = (path: string) => readFileSync(resolvePath(ROOT, path), "utf8");

type Attrs = Record<string, string>;

/** Every `<rect .../>` of an SVG as an attribute map, in document order. */
function rects(svg: string): Attrs[] {
  return [...svg.matchAll(/<rect\b([^>]*?)\/?>/g)].map((m) => {
    const attrs: Attrs = {};
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
      attrs[a[1]] = a[2];
    }
    return attrs;
  });
}

const has = (list: Attrs[], x: string, y: string, w: string, h: string) =>
  list.find((r) => r.x === x && r.y === y && r.width === w && r.height === h);

describe("brand", () => {
  it("brand_has_the_owner_decisions", () => {
    assert.equal(brand.displayName, "Vaakora");
    assert.equal(appName, "Vaakora");
    assert.equal(brand.appId, "dev.jugraj.vaakora");
    assert.equal(brand.packageName, "vaakora");
    assert.deepEqual(brand.mark, {
      tile: "#2d583a",
      bars: "#f1f6f2",
      cursor: "#a9e1b4",
      keyline: "#658b6f",
    });
    assert.equal(brand.theme.light.text, "#121a15");
    // open question 2: S3's own built dark ink-3, not S2's #b6b6b3
    assert.equal(brand.theme.dark["ink-3"], "#b1b8b2");
    assert.equal(brand.updater.endpoint, null);
  });

  it("sixteen_master_is_square_ended", () => {
    const light = rects(read("brand/mark/vaakora-16.svg"));
    const dark = rects(read("brand/mark/vaakora-16-dark.svg"));
    for (const list of [light, dark]) {
      const tile = list.find((r) => r.width === "16" && r.height === "16");
      assert.ok(tile, "tile rect");
      assert.equal(tile.rx, "3.5");
      for (const [x, y, w, h] of [
        ["2", "6", "2", "4"],
        ["5", "3", "2", "10"],
        ["10", "2", "2", "12"],
        ["8", "2", "6", "2"],
        ["8", "12", "6", "2"],
      ]) {
        const r = has(list, x, y, w, h);
        assert.ok(r, `rect ${x},${y},${w},${h} present`);
        assert.equal(r.rx, undefined, `rect ${x},${y},${w},${h} has no rx`);
      }
    }
    assert.equal(light.length, 6);
    assert.equal(dark.length, 7);
    assert.equal(
      light.find((r) => r.stroke !== undefined),
      undefined,
      "the light file has no keyline",
    );
    const keyline = dark.filter((r) => r.stroke !== undefined);
    assert.equal(keyline.length, 1);
    assert.equal(keyline[0].x, ".5");
    assert.equal(keyline[0].y, ".5");
    assert.equal(keyline[0].width, "15");
    assert.equal(keyline[0].height, "15");
    assert.equal(keyline[0].rx, "3");
    assert.equal(keyline[0].stroke, "#658b6f");
  });

  it("wordmark_matches_the_showcase_outline", () => {
    const wm = JSON.parse(read("brand/generated/wordmark-latin.json")) as {
      upm: number;
      width: number;
      paths: string[];
    };
    assert.equal(wm.upm, 2000);
    // the showcase's anek-600 entry in wordmarks.json: same font, same kerning
    assert.equal(wm.width, 6995);
    assert.equal(wm.paths.length, 7);
  });
});
