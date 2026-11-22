import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const BASE_ID = "aca8985190c3ad7f361d8a80cb30f179513ed690";
const BASE_SHORT = "aca89851";
const UPSTREAM_REF = "refs/remotes/upstream/main";
const ABBREV = 8;
const CREDIT_LINK = "[Handy](https://github.com/cjpais/Handy)";
const DECISIONS = new Set([
  "adopted",
  "rewritten",
  "declined",
  "already-here",
  "pending",
]);
const UPSTREAM_COPYRIGHT = "Copyright (c) 2025 CJ Pais";
const OWN_COPYRIGHT = "Copyright (c) 2026 Jugraj Singh";

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readFile(name: string): string | null {
  const file = path.join(ROOT, name);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

// The import commit carries the same LICENSE as the upstream base, which a clone of this repository does not hold.
function licenseBaseCommit(): string | null {
  try {
    git("cat-file", "-e", `${BASE_SHORT}^{commit}`);
    return BASE_SHORT;
  } catch {
    const roots = git("rev-list", "--max-parents=0", "HEAD")
      .split("\n")
      .filter(Boolean);
    return roots.length === 1 ? roots[0] : null;
  }
}

function checkLicense(problems: string[]): void {
  const actual = readFile("LICENSE");
  if (actual === null) {
    problems.push("LICENSE: file is missing");
    return;
  }
  const baseCommit = licenseBaseCommit();
  if (baseCommit === null) {
    problems.push(
      `LICENSE: cannot find ${BASE_SHORT} or a single root commit to compare against`,
    );
    return;
  }
  const upstream = git("show", `${baseCommit}:LICENSE`);
  const expected = upstream.replace(
    UPSTREAM_COPYRIGHT,
    `${OWN_COPYRIGHT}\n${UPSTREAM_COPYRIGHT}`,
  );
  if (actual !== expected) {
    problems.push(
      `LICENSE: differs from the base text at ${baseCommit} with the lines "${OWN_COPYRIGHT}" then "${UPSTREAM_COPYRIGHT}" in place of the single copyright line`,
    );
  }
}

function checkReadme(problems: string[]): void {
  const readme = readFile("README.md");
  if (readme === null) {
    problems.push("README.md: file is missing");
  } else if (!readme.includes(CREDIT_LINK)) {
    problems.push(`README.md: missing the credit link ${CREDIT_LINK}`);
  }
}

function checkUpstreamLedger(problems: string[]): void {
  const ledger = readFile("UPSTREAM.md");
  if (ledger === null) {
    problems.push("UPSTREAM.md: file is missing");
    return;
  }
  const lines = ledger.split("\n");

  const baseLine = lines.find((line) => line.startsWith("Base:"));
  if (baseLine === undefined) {
    problems.push("UPSTREAM.md: no line starting with 'Base:'");
  } else if (!baseLine.includes(BASE_ID)) {
    problems.push(`UPSTREAM.md: Base line does not name ${BASE_ID}`);
  }

  const rowHashes: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const [hash, , decision] = cells;
    if (hash === "Upstream commit" || /^-+$/.test(hash ?? "")) continue;
    if (cells.length !== 4) {
      problems.push(
        `UPSTREAM.md: row has ${cells.length} cells, need 4: ${line}`,
      );
      continue;
    }
    rowHashes.push(hash);
    if (!DECISIONS.has(decision)) {
      problems.push(
        `UPSTREAM.md: row ${hash} has decision "${decision}", need one of ${[...DECISIONS].join("|")}`,
      );
    }
  }

  const ref = (() => {
    try {
      git("rev-parse", "--verify", "--quiet", UPSTREAM_REF);
      return true;
    } catch {
      return false;
    }
  })();
  if (!ref) {
    console.log("SKIP upstream set (no upstream ref)");
    return;
  }
  const expected = git(
    "rev-list",
    "--abbrev-commit",
    `--abbrev=${ABBREV}`,
    `${BASE_SHORT}..${UPSTREAM_REF}`,
  )
    .split("\n")
    .filter(Boolean);
  for (const hash of expected) {
    if (!rowHashes.includes(hash)) {
      problems.push(`UPSTREAM.md: no row for upstream commit ${hash}`);
    }
  }
  for (const hash of new Set(rowHashes)) {
    if (!expected.includes(hash)) {
      problems.push(
        `UPSTREAM.md: row ${hash} is not an upstream commit after ${BASE_SHORT}`,
      );
    }
  }
  if (new Set(rowHashes).size !== rowHashes.length) {
    problems.push("UPSTREAM.md: a commit has more than one row");
  }
}

function main(): void {
  const problems: string[] = [];
  checkLicense(problems);
  checkReadme(problems);
  checkUpstreamLedger(problems);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log("PROVENANCE PASS");
}

main();
