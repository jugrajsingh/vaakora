import { describe, expect, it } from "bun:test";
import {
  desktopProblems,
  headerProblems,
  licenceProblems,
  overlapProblems,
  pathProblems,
  STRINGS_ALLOW,
  stringsProblems,
  type StringsAllow,
} from "./brand-rpm";

const BRAND = { displayName: "Vaakora", packageName: "vaakora" };

const DESKTOP = [
  "[Desktop Entry]",
  "Categories=AudioVideo;",
  "Comment=Speech to text and read aloud on your own computer",
  "Exec=vaakora",
  "Icon=vaakora",
  "Name=Vaakora",
  "StartupWMClass=vaakora",
  "Terminal=false",
  "Type=Application",
  "",
].join("\n");

const PATHS = [
  "/usr/bin/vaakora",
  "/usr/lib/Vaakora",
  "/usr/lib/Vaakora/tts/vaakora-tts",
  "/usr/share/applications/Vaakora.desktop",
  "/usr/share/icons/hicolor/32x32/apps/vaakora.png",
  "/usr/share/icons/hicolor/256x256@2/apps/vaakora.png",
  "/usr/share/licenses/vaakora/LICENSE",
];

const ALLOW: StringsAllow[] = [
  { at: /^HANDY_[A-Z]/, why: "environment variable names" },
  { at: /^handy-keys/i, why: "the handy-keys crate" },
];

describe("rpm brand checks", () => {
  it("desktop_entry_names_the_brand", () => {
    expect(desktopProblems(DESKTOP, BRAND)).toEqual([]);
  });

  it("desktop_entry_with_the_old_name_fails", () => {
    const old = DESKTOP.replace("Name=Vaakora", "Name=Handy");
    const problems = desktopProblems(old, BRAND);
    expect(problems).toContain("desktop entry has no Name=Vaakora line");
    expect(problems.some((p) => p.includes('names Handy: "Name=Handy"'))).toBe(
      true,
    );
  });

  it("desktop_entry_with_a_wrong_exec_or_icon_fails", () => {
    expect(
      desktopProblems(DESKTOP.replace("Exec=vaakora", "Exec=handy"), BRAND),
    ).toContain("desktop entry has no Exec=vaakora line");
    expect(
      desktopProblems(DESKTOP.replace("Icon=vaakora", "Icon=other"), BRAND),
    ).toContain("desktop entry has no Icon=vaakora line");
  });

  it("paths_outside_the_brand_fail", () => {
    expect(pathProblems(PATHS, BRAND)).toEqual([]);
    expect(pathProblems([...PATHS, "/usr/bin/handy"], BRAND)).toEqual([
      "RPM path /usr/bin/handy is outside the Vaakora paths",
    ]);
    expect(
      pathProblems(["/usr/share/icons/hicolor/32x32/apps/handy.png"], BRAND),
    ).toHaveLength(1);
    expect(pathProblems(["/usr/lib/VaakoraX/file"], BRAND)).toHaveLength(1);
    expect(pathProblems(["/usr/share/doc/vaakora/NOTICE"], BRAND)).toHaveLength(
      1,
    );
  });

  it("header_naming_handy_or_its_author_fails", () => {
    const good =
      "vaakora Speech to text and read aloud https://github.com/jugrajsingh/vaakora (none) MIT\nVaakora";
    expect(headerProblems(good)).toEqual([]);
    expect(headerProblems(good.replace("Vaakora", "Handy"))).not.toEqual([]);
    expect(headerProblems(`${good} https://github.com/cjpais/x`)).not.toEqual(
      [],
    );
  });

  it("licence_must_equal_the_repository_licence", () => {
    const repo = Buffer.from("MIT License\n");
    expect(licenceProblems(Buffer.from("MIT License\n"), repo)).toEqual([]);
    expect(licenceProblems(Buffer.from("MIT License\n\n"), repo)).toHaveLength(
      1,
    );
    expect(licenceProblems(null, repo)).toHaveLength(1);
  });

  it("a_shared_path_with_the_handy_package_fails", () => {
    expect(overlapProblems(PATHS, ["/usr/bin/handy"], "handy")).toEqual([]);
    expect(
      overlapProblems(PATHS, ["/usr/bin/handy", "/usr/lib/Vaakora"], "handy"),
    ).toEqual(["RPM path /usr/lib/Vaakora is also owned by handy"]);
  });

  it("strings_scan_allows_only_listed_internal_identifiers", () => {
    expect(stringsProblems("HANDY_TTS_WORKER\nxHANDY_X_Y", ALLOW)).toEqual([]);
    // Rust packs literals together, so a rule matches from the hit, not around it.
    expect(
      stringsProblems("tray.statusHANDY_GDK_BACKENDhandy-keys:", ALLOW),
    ).toEqual([]);
    const problems = stringsProblems(
      "ok HANDY_TTS_WORKERvaakora (set by Handy: x)\nQuit Handy first\nQuit Handy first",
      ALLOW,
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("(set by Handy: x)");
    expect(problems[0].endsWith("(1x)")).toBe(true);
    expect(problems[1]).toContain("Quit Handy first");
    expect(problems[1].endsWith("(2x)")).toBe(true);
  });

  it("a_rule_with_a_before_part_needs_it", () => {
    const allow: StringsAllow[] = [
      { at: /^handy/, before: /com\.pais\.$/, why: "the legacy app id here" },
    ];
    expect(stringsProblems("xcom.pais.handyy", allow)).toEqual([]);
    expect(stringsProblems("xpais.handyy", allow)).toHaveLength(1);
  });

  it("every_allow_rule_says_why", () => {
    for (const rule of STRINGS_ALLOW) {
      expect(rule.why.length).toBeGreaterThan(10);
      expect(rule.at.source.startsWith("^")).toBe(true);
    }
  });
});
