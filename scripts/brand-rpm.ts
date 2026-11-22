/**
 * Checks on a built Vaakora RPM for `scripts/check-brand.ts --rpm <abs rpm>`.
 * The pure functions take text, bytes or path lists and return one message per
 * problem (empty when fine); `rpmProblems` runs rpm, rpm2cpio, cpio and strings
 * and feeds them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RpmBrand {
  displayName: string;
  packageName: string;
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The package name, summary, URL, vendor, licence and description name neither Handy nor its author. */
export function headerProblems(header: string): string[] {
  const problems: string[] = [];
  for (const m of header.matchAll(/handy|cjpais/gi)) {
    const at = m.index ?? 0;
    problems.push(
      `RPM header names ${m[0]} near ${JSON.stringify(header.slice(Math.max(0, at - 30), at + 30))}`,
    );
  }
  return problems;
}

/** Every packaged path is one the brand owns: the binary, the install dir, the desktop entry, the icons, the licence. */
export function pathProblems(paths: string[], brand: RpmBrand): string[] {
  const pkg = escapeRegExp(brand.packageName);
  const dir = escapeRegExp(brand.displayName);
  const owned = new RegExp(
    `^/usr/(bin/${pkg}|lib/${dir}(/.*)?|share/applications/${dir}\\.desktop|share/icons/hicolor/[^/]+/apps/${pkg}\\.png|share/licenses/${pkg}/LICENSE)$`,
  );
  return paths
    .filter((p) => !owned.test(p))
    .map((p) => `RPM path ${p} is outside the Vaakora paths`);
}

/** The desktop entry names the brand: Name, Exec and Icon lines, and no Handy anywhere. */
export function desktopProblems(text: string, brand: RpmBrand): string[] {
  const problems: string[] = [];
  const lines = text.split("\n");
  for (const want of [
    `Name=${brand.displayName}`,
    `Exec=${brand.packageName}`,
    `Icon=${brand.packageName}`,
  ]) {
    if (!lines.includes(want))
      problems.push(`desktop entry has no ${want} line`);
  }
  for (const line of lines) {
    if (/handy/i.test(line))
      problems.push(`desktop entry names Handy: ${JSON.stringify(line)}`);
  }
  return problems;
}

/** The licence in the package is the repository's LICENSE, byte for byte. */
export function licenceProblems(inRpm: Buffer | null, repo: Buffer): string[] {
  if (inRpm === null) return ["RPM carries no licence file"];
  return inRpm.equals(repo)
    ? []
    : ["RPM licence differs from the repository LICENSE"];
}

/** Paths both packages own. */
export function overlapProblems(
  mine: string[],
  theirs: string[],
  other: string,
): string[] {
  const owned = new Set(theirs);
  return mine
    .filter((p) => owned.has(p))
    .map((p) => `RPM path ${p} is also owned by ${other}`);
}

/** One allowed use of the old name in the binary, and why it stays. */
export interface StringsAllow {
  /** Tested against the text starting at the "handy" match (any case). */
  at: RegExp;
  /** When set, also tested against the text just before the match (it must end there). */
  before?: RegExp;
  why: string;
}

/**
 * Handy hits in `strings` output that no allow rule covers. The binary packs
 * Rust string literals together with no separator, so a rule matches the text
 * that STARTS at the hit, never a "word" around it. Each distinct context is
 * reported once with its count.
 */
export function stringsProblems(out: string, allow: StringsAllow[]): string[] {
  const hits = new Map<string, number>();
  for (const line of out.split("\n")) {
    for (const m of line.matchAll(/handy/gi)) {
      const at = m.index ?? 0;
      const after = line.slice(at);
      const prior = line.slice(Math.max(0, at - 24), at);
      if (
        allow.some(
          (a) => a.at.test(after) && (!a.before || a.before.test(prior)),
        )
      )
        continue;
      const context = line.slice(Math.max(0, at - 20), at + 40);
      hits.set(context, (hits.get(context) ?? 0) + 1);
    }
  }
  return [...hits].map(
    ([context, n]) =>
      `binary names Handy in ${JSON.stringify(context)} (${n}x)`,
  );
}

/** What a command printed, or why it could not run. */
function run(
  cwd: string,
  script: string,
  ...args: string[]
): { ok: boolean; out: Buffer; err: string } {
  const r = spawnSync(
    "bash",
    ["-c", `set -o pipefail; ${script}`, "_", ...args],
    {
      cwd,
      maxBuffer: 1 << 30,
    },
  );
  return {
    ok: r.status === 0 && !r.error,
    out: r.stdout ?? Buffer.alloc(0),
    err: `${r.error ? `${r.error.message} ` : ""}${String(r.stderr ?? "")}`,
  };
}

/**
 * `strings -a` on the extracted binary, run directly: a tool that is missing
 * or exits non-zero is a problem (never an empty, passing scan), and its output
 * goes to `stringsProblems`. `env` lets a test control PATH.
 */
export function binaryScanProblems(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const r = spawnSync("strings", ["-a", binary], { env, maxBuffer: 1 << 30 });
  if (r.error) return [`strings could not run: ${r.error.message}`];
  if (r.status !== 0) {
    return [`strings exited ${String(r.status)}: ${String(r.stderr).trim()}`];
  }
  return stringsProblems(r.stdout.toString("latin1"), STRINGS_ALLOW);
}

/**
 * What the binary may still say with "handy" in it (ruling Q6 and the Task 3
 * list). Internal identifiers only: none of these is text a person reads. Log
 * and error lines that name the old app are NOT here; they fail the scan.
 */
export const STRINGS_ALLOW: StringsAllow[] = [
  {
    at: /^(?:handy[-_]ke|HandyKe)/i,
    why: "the handy-keys crate, the HandyKeys shortcut implementation and its stored value handy_keys (Q6)",
  },
  { at: /^HANDY_[A-Z]/, why: "HANDY_* environment variable names (Q6)" },
  {
    at: /^handy[-_]tt/i,
    why: "the handy-tts crate, its worker protocol prefix and manifest id (Q6)",
  },
  {
    at: /^handy[-_](?:recorder|cpal)/i,
    why: "dependency crates handy-recorder and handy-cpal, their names and registry paths",
  },
  {
    at: /^handy-computer\//,
    why: "model ids under the handy-computer namespace (Q6)",
  },
  {
    at: /^handy\.computer/,
    why: "the model download host blob.handy.computer (plan scope: not changed)",
  },
  {
    at: /^handy/,
    before: /com\.pais\.$/,
    why: "the legacy app id, brand.json legacy.appId, read by the data import",
  },
  {
    at: /^handy-import\.json/,
    why: "the data-import report file name fixed by the Task 8 design",
  },
  {
    at: /^handy-(?:file-)?(?:$|[^a-z])/,
    why: "recording file names handy-<time>.wav and handy-file-<time>.wav: stored in history rows and in the data Vaakora imports",
  },
  { at: /^handy-process-spawner/, why: "an OS thread name" },
  {
    at: /^Handy Portable M/,
    why: "the portable marker file content, read back by portable.rs",
  },
  {
    at: /^HANDY underscore/,
    why: "the built-in vocabulary entry that says the HANDY_TTS_WORKER name",
  },
  {
    at: /^Handy(?:'s (?:macOS grant|detector|spoken-language detector)| (?:already ships|obtains it|had to pick|asks for during onboarding|can read|can't do its job|via CLI flags))|^Handy's\. Auto needs/,
    why: "rustdoc text of exported types that specta embeds in the binary; never shown",
  },
];

/**
 * Run every RPM check. `root` is the repository (LICENSE, scratch under
 * target/brand-rpm).
 */
export function rpmProblems(
  rpm: string,
  root: string,
  brand: RpmBrand,
): string[] {
  const problems: string[] = [];
  if (!rpm.startsWith("/") || !existsSync(rpm)) {
    return [
      `--rpm needs an absolute path to an existing file, got ${JSON.stringify(rpm)}`,
    ];
  }
  const scratch = join(root, "target", "brand-rpm");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  try {
    const header = run(
      root,
      `rpm -qp --qf '%{NAME} %{SUMMARY} %{URL} %{VENDOR} %{LICENSE}\\n%{DESCRIPTION}' "$1"`,
      rpm,
    );
    if (!header.ok) problems.push(`rpm -qp failed: ${header.err.trim()}`);
    else problems.push(...headerProblems(header.out.toString("utf8")));

    const list = run(root, `rpm -qlp "$1"`, rpm);
    const paths = list.out.toString("utf8").split("\n").filter(Boolean);
    if (!list.ok || paths.length === 0)
      problems.push(`rpm -qlp failed: ${list.err.trim()}`);
    problems.push(...pathProblems(paths, brand));

    // cpio exits 0 when the member is absent, so a missing member is an empty file.
    // Returns null when the member was written, else why not.
    const extract = (member: string, to: string): string | null => {
      const r = run(
        scratch,
        `rpm2cpio "$1" | cpio -i --to-stdout "$2" > "$3"`,
        rpm,
        member,
        to,
      );
      if (!r.ok) return `rpm2cpio | cpio failed: ${r.err.trim()}`;
      return statSync(to).size > 0 ? null : "member is not in the package";
    };

    const desktop = join(scratch, "app.desktop");
    const desktopWhy = extract(
      `./usr/share/applications/${brand.displayName}.desktop`,
      desktop,
    );
    if (desktopWhy === null) {
      problems.push(...desktopProblems(readFileSync(desktop, "utf8"), brand));
    } else {
      problems.push(
        `RPM has no /usr/share/applications/${brand.displayName}.desktop (${desktopWhy})`,
      );
    }

    const licence = join(scratch, "LICENSE");
    const licenceWhy = extract(
      `./usr/share/licenses/${brand.packageName}/LICENSE`,
      licence,
    );
    problems.push(
      ...licenceProblems(
        licenceWhy === null ? readFileSync(licence) : null,
        readFileSync(join(root, "LICENSE")),
      ),
    );

    const handy = run(root, "rpm -ql handy");
    if (handy.ok) {
      problems.push(
        ...overlapProblems(
          paths,
          handy.out.toString("utf8").split("\n").filter(Boolean),
          "the installed handy package",
        ),
      );
    } else {
      // rpm -ql exits 1 for an absent package; any other failure is a problem.
      const asked = run(root, "rpm -q handy");
      if (
        /is not installed/.test(`${asked.out.toString("utf8")}${asked.err}`)
      ) {
        console.log(
          "NOTE rpm: handy is not installed, so path overlap with it was not checked",
        );
      } else {
        problems.push(`rpm -ql handy failed: ${handy.err.trim()}`);
      }
    }

    const binary = join(scratch, "app.bin");
    const binaryWhy = extract(`./usr/bin/${brand.packageName}`, binary);
    if (binaryWhy === null) {
      problems.push(...binaryScanProblems(binary));
    } else {
      problems.push(
        `RPM has no /usr/bin/${brand.packageName} to scan (${binaryWhy})`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return problems;
}
