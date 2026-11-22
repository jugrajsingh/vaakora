/**
 * Pixel reads for the generated brand rasters: an 8-bit RGBA non-interlaced PNG
 * (the only shape `scripts/brand-icons.sh` writes) decoded with node:zlib, and
 * the rule for the Colored Transcribing tray icon (a pale tile with a thin
 * forest outline, so it reads on a light panel).
 */
import { inflateSync } from "node:zlib";

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Decode an 8-bit RGBA, non-interlaced PNG; throws on any other shape. */
export function decodePng(buf: Buffer): Rgba {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(sig)) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) {
        throw new Error("not 8-bit RGBA non-interlaced");
      }
    } else if (type === "IDAT") {
      idat.push(body);
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  if (raw.length !== height * (stride + 1)) throw new Error("bad PNG data");
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? data[y * stride + i - 4] : 0;
      const up = y > 0 ? data[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= 4 ? data[(y - 1) * stride + i - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pl = Math.abs(p - left);
        const pu = Math.abs(p - up);
        const pul = Math.abs(p - upLeft);
        predictor = pl <= pu && pl <= pul ? left : pu <= pul ? up : upLeft;
      } else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
      data[y * stride + i] = (line[i] + predictor) & 255;
    }
  }
  return { width, height, data };
}

/** `#rrggbbaa` of one pixel. */
export function pixelHex(img: Rgba, x: number, y: number): string {
  const at = (y * img.width + x) * 4;
  return `#${Array.from(img.data.subarray(at, at + 4), (v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Problems with the Colored Transcribing raster (64x64, the 16 grid at 4x): the
 * outline is forest, opaque, one grid unit wide on every side, inside it the
 * tile stays pale, and the corner outside the rounded tile is transparent.
 */
export function transcribingOutlineProblems(
  img: Rgba,
  forest: string,
  pale: string,
): string[] {
  const problems: string[] = [];
  if (img.width !== 64 || img.height !== 64) {
    return [`is ${img.width}x${img.height}, want 64x64`];
  }
  const want = (label: string, x: number, y: number, hex: string) => {
    const got = pixelHex(img, x, y);
    if (got !== hex)
      problems.push(`${label} pixel (${x},${y}) is ${got}, want ${hex}`);
  };
  const edge = `${forest}ff`;
  for (const [label, x, y] of [
    ["left outline", 1, 32],
    ["right outline", 62, 32],
    ["top outline", 32, 1],
    ["bottom outline", 32, 62],
  ] as const) {
    want(label, x, y, edge);
  }
  want("tile inside the outline", 5, 32, `${pale}ff`);
  want("tile centre", 32, 32, `${pale}ff`);
  want("corner outside the tile", 0, 0, "#00000000");
  return problems;
}
