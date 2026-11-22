import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { svgProblems } from "../../scripts/brand-svg";
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

type Bounds = [number, number, number, number];

/** Interior extremum parameters of a 1-D Bezier (degree 2 or 3). */
function extrema(p: number[]): number[] {
  const ts: number[] = [];
  if (p.length === 3) {
    const d = p[0] - 2 * p[1] + p[2];
    if (d !== 0) ts.push((p[0] - p[1]) / d);
  } else {
    const a = -p[0] + 3 * p[1] - 3 * p[2] + p[3];
    const b = 2 * (p[0] - 2 * p[1] + p[2]);
    const c = p[1] - p[0];
    if (Math.abs(a) < 1e-12) {
      if (b !== 0) ts.push(-c / b);
    } else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        ts.push((-b + Math.sqrt(disc)) / (2 * a));
        ts.push((-b - Math.sqrt(disc)) / (2 * a));
      }
    }
  }
  return ts.filter((t) => t > 0 && t < 1);
}

const bez = (p: number[], t: number) => {
  const u = 1 - t;
  return p.length === 3
    ? u * u * p[0] + 2 * u * t * p[1] + t * t * p[2]
    : u * u * u * p[0] +
        3 * u * u * t * p[1] +
        3 * u * t * t * p[2] +
        t * t * t * p[3];
};

/** Exact bounds of absolute M L H V Q C Z path data (what SVGPathPen emits). */
function pathBounds(d: string): Bounds {
  const bounds: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number) => {
    bounds[0] = Math.min(bounds[0], x);
    bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x);
    bounds[3] = Math.max(bounds[3], y);
  };
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  for (const m of d.matchAll(/([MLHVQCZ])([^MLHVQCZ]*)/g)) {
    const n = (m[2].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    switch (m[1]) {
      case "M":
        [cx, cy] = [sx, sy] = [n[0], n[1]];
        add(cx, cy);
        break;
      case "L":
        [cx, cy] = [n[0], n[1]];
        add(cx, cy);
        break;
      case "H":
        cx = n[0];
        add(cx, cy);
        break;
      case "V":
        cy = n[0];
        add(cx, cy);
        break;
      case "Q":
      case "C": {
        const xs = [cx];
        const ys = [cy];
        for (let i = 0; i < n.length; i += 2) {
          xs.push(n[i]);
          ys.push(n[i + 1]);
        }
        for (const t of [...extrema(xs), ...extrema(ys)]) {
          add(bez(xs, t), bez(ys, t));
        }
        [cx, cy] = [xs[xs.length - 1], ys[ys.length - 1]];
        add(cx, cy);
        break;
      }
      default:
        [cx, cy] = [sx, sy];
    }
  }
  return bounds;
}

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

  it("keeps every wordmark outline inside its viewBox", () => {
    for (const name of ["latin", "pa", "hi"]) {
      const svg = read(`brand/wordmark/vaakora-${name}.svg`);
      const vb = /viewBox="([^"]+)"/.exec(svg)?.[1]?.split(" ").map(Number);
      assert.ok(vb && vb.length === 4, `${name} has a viewBox`);
      const [vx, vy, vw, vh] = vb;
      const [x0, y0, x1, y1] = [...svg.matchAll(/ d="([^"]+)"/g)]
        .map((m) => pathBounds(m[1]))
        .reduce<Bounds>(
          (a, b) => [
            Math.min(a[0], b[0]),
            Math.min(a[1], b[1]),
            Math.max(a[2], b[2]),
            Math.max(a[3], b[3]),
          ],
          [Infinity, Infinity, -Infinity, -Infinity],
        );
      const eps = 1e-6;
      assert.ok(x0 >= vx - eps, `${name} left ${x0} < ${vx}`);
      assert.ok(y0 >= vy - eps, `${name} top ${y0} < ${vy}`);
      assert.ok(x1 <= vx + vw + eps, `${name} right ${x1} > ${vx + vw}`);
      assert.ok(y1 <= vy + vh + eps, `${name} bottom ${y1} > ${vy + vh}`);
    }
  });

  it("parses SVG masters as XML and rejects an unquoted attribute", () => {
    const ok =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="#2d583a"/></svg>';
    assert.deepEqual(svgProblems(ok), []);
    for (const master of [
      "brand/mark/vaakora-16.svg",
      "brand/tray/tray-16.svg",
      "brand/wordmark/vaakora-latin.svg",
    ]) {
      assert.deepEqual(svgProblems(read(master)), [], master);
    }
    const unquoted = ok.replace('fill="#2d583a"', "fill=#2d583a");
    assert.ok(svgProblems(unquoted).length > 0, "unquoted attribute");
    const unclosed = ok.replace("</svg>", "");
    assert.ok(svgProblems(unclosed).length > 0, "unclosed root");
    assert.ok(
      svgProblems(ok.replace("<rect", '<rect filter="url(#f)"')).length > 0,
      "filter attribute",
    );
    assert.ok(
      svgProblems(ok.replace(' viewBox="0 0 1 1"', ' width="1"')).length > 0,
      "missing viewBox and a width",
    );
  });
});
