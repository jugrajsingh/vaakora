import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CREDITED_ROW = /^\| 939c9573 .*$/m;
// Each case works in a clone that holds the full history. The working copies
// of the script and the ledger are copied over it, so uncommitted edits count.
let work: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Provenance Test",
      "-c",
      "user.email=provenance-test@example.invalid",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function run(cwd: string): { code: number | null; out: string } {
  const result = spawnSync(
    process.execPath,
    [path.join(cwd, "scripts", "check-provenance.ts")],
    { cwd, encoding: "utf8" },
  );
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function freshClone(name: string): string {
  const dir = path.join(work, name);
  git(work, "clone", "--quiet", ROOT, dir);
  fs.copyFileSync(
    path.join(ROOT, "scripts", "check-provenance.ts"),
    path.join(dir, "scripts", "check-provenance.ts"),
  );
  fs.copyFileSync(
    path.join(ROOT, "UPSTREAM.md"),
    path.join(dir, "UPSTREAM.md"),
  );
  return dir;
}

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "check-provenance-"));
});

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe("check-provenance credit check", () => {
  it("passes on the current repository", () => {
    const { code, out } = run(ROOT);
    expect(out).toContain("PROVENANCE PASS");
    expect(code).toBe(0);
  });

  it("fails when a Based-on line has no row", () => {
    const dir = freshClone("no-row");
    const ledger = path.join(dir, "UPSTREAM.md");
    const text = fs.readFileSync(ledger, "utf8");
    expect(text).toMatch(CREDITED_ROW);
    fs.writeFileSync(ledger, text.replace(CREDITED_ROW, ""));
    const { code, out } = run(dir);
    expect(out).toContain("Based on: cjpais/Handy@939c9573");
    expect(code).toBe(1);
  });

  it("fails when an upstream-commit row names a commit without the line", () => {
    const dir = freshClone("no-line");
    const ledger = path.join(dir, "UPSTREAM.md");
    const text = fs.readFileSync(ledger, "utf8");
    const root = git(dir, "rev-list", "--max-parents=0", "HEAD")
      .trim()
      .slice(0, 8);
    const row = text.match(CREDITED_ROW)?.[0] ?? "";
    const moved = row.replace(/\| \w{8}\s+\|$/, `| ${root} |`);
    expect(moved).not.toBe(row);
    fs.writeFileSync(ledger, text.replace(row, moved));
    const { code, out } = run(dir);
    expect(out).toContain(`names our commit ${root}`);
    expect(code).toBe(1);
  });

  it("fails when a new commit carries a Based-on line and no row names it", () => {
    const dir = freshClone("new-commit");
    git(
      dir,
      "commit",
      "--allow-empty",
      "-m",
      "fix: other\n\nBased on: cjpais/Handy@0123456789 by someone",
    );
    const { code, out } = run(dir);
    expect(out).toContain("Based on: cjpais/Handy@0123456789");
    expect(code).toBe(1);
  });

  it("fails on a malformed Based-on line", () => {
    const dir = freshClone("malformed");
    git(dir, "commit", "--allow-empty", "-m", "fix: other\n\nBased on: Bruno");
    const { code, out } = run(dir);
    expect(out).toContain("malformed credit line");
    expect(code).toBe(1);
  });
});
