import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const {
  describe,
  it,
}: {
  describe: (name: string, run: () => void) => void;
  it: (name: string, run: () => Promise<void> | void) => void;
} = createRequire(import.meta.url)("bun:test");

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, "..");
const NEEDLE = "mid" + "-gray";
const THEME_FILE = resolve(HERE, "theme.css");
const SELF_FILE = fileURLToPath(import.meta.url);
const EXTENSIONS = [".ts", ".tsx", ".css"];

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
});
