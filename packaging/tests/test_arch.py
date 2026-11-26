import hashlib
import json
import os
import re
import shutil
import subprocess
import unittest

from roots import PACKAGING, ROOT, SCRATCH

SCRIPT = PACKAGING / "arch-package.sh"
PKGBUILD = PACKAGING / "arch/PKGBUILD"
BUILD = PACKAGING / ".work/arch-build"
IMAGE = "vaakora-build:arch"
DEPENDS = (
    "alsa-lib",
    "cairo",
    "dbus",
    "gcc-libs",
    "gdk-pixbuf2",
    "glib2",
    "glibc",
    "gtk-layer-shell",
    "gtk3",
    "libayatana-appindicator",
    "libsoup3",
    "ocl-icd",
    "openblas",
    "vulkan-icd-loader",
    "webkit2gtk-4.1",
)
# One line per call, arguments tab-separated. `build` fails unless its context is empty; `run` keeps the PKGBUILD makepkg saw,
# writes the package, then exits MAKEPKG_RC (the package already written, so a swallowed failure would ship it).
PODMAN = r"""{ for arg; do printf '%s\t' "$arg"; done; echo; } >>"$TRACE"
for last; do :; done
case "$1" in
  build) [ -z "$(ls -A "$last")" ] || exit 65 ;;
  run)
    for arg; do case "$arg" in *:/pkg:z) pkg=${arg%:/pkg:z} ;; esac; done
    [ -f "$pkg/PKGBUILD" ] || exit 66
    cp "$pkg/PKGBUILD" "$SEEN"
    version=$(sed -n 's/^pkgver=//p' "$pkg/PKGBUILD")
    [ -f "$pkg/Vaakora_${version}_amd64.deb" ] || exit 67
    echo package >"$pkg/vaakora-$version-1-x86_64.pkg.tar.zst"
    exit "${MAKEPKG_RC:-0}"
    ;;
  *) exit 64 ;;
esac
"""


def assignment(text: str, name: str) -> str:
    match = re.search(rf"(?m)^{name}=(.*)$", text)
    if match is None:
        raise AssertionError(f"no {name}= line")
    return match.group(1)


class ArchPackageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scratch = SCRATCH / "arch-fixture"
        shutil.rmtree(self.scratch, ignore_errors=True)
        self.scratch.mkdir(parents=True)
        bin_dir = self.scratch / "bin"
        bin_dir.mkdir()
        podman = bin_dir / "podman"
        podman.write_text("#!/bin/sh\nset -eu\n" + PODMAN)
        podman.chmod(0o755)
        self.deb = self.scratch / "Vaakora_1.2.3_amd64.deb"
        self.deb.write_bytes(b"fixture deb payload")
        self.out = self.scratch / "out"
        self.out.mkdir()
        self.trace = self.scratch / "trace"
        self.seen = self.scratch / "seen-PKGBUILD"
        self.environment = {
            **os.environ,
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "TRACE": str(self.trace),
            "SEEN": str(self.seen),
        }

    def tearDown(self) -> None:
        shutil.rmtree(self.scratch)

    def run_script(self, deb: str, **environment: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(SCRIPT), deb, str(self.out)],
            env={**self.environment, **environment},
            capture_output=True,
            text=True,
            check=False,
        )

    def calls(self) -> list[list[str]]:
        return [line.split("\t")[:-1] for line in self.trace.read_text().splitlines()]

    def test_pkgbuild_gets_version_and_deb_sha256(self) -> None:
        tracked = PKGBUILD.read_bytes()
        BUILD.mkdir(parents=True, exist_ok=True)
        (BUILD / "stale").write_text("left by an earlier run")
        result = self.run_script(str(self.deb))
        self.assertEqual(result.returncode, 0, result.stderr)
        sha = hashlib.sha256(self.deb.read_bytes()).hexdigest()
        work = (BUILD / "PKGBUILD").read_text()
        self.assertEqual(assignment(work, "pkgver"), "1.2.3")
        self.assertEqual(assignment(work, "sha256sums"), f"('{sha}')")
        self.assertEqual(self.seen.read_text(), work)
        self.assertEqual((BUILD / self.deb.name).read_bytes(), self.deb.read_bytes())
        self.assertFalse((BUILD / "stale").exists(), "the build directory is not recreated")
        self.assertEqual(PKGBUILD.read_bytes(), tracked, "the tracked PKGBUILD changed")
        package = self.out / "vaakora-1.2.3-1-x86_64.pkg.tar.zst"
        self.assertEqual(package.read_text(), "package\n")
        self.assertIn(f"built: {package}\n", result.stdout)

    def test_makepkg_runs_offline_as_the_build_user(self) -> None:
        result = self.run_script(str(self.deb))
        self.assertEqual(result.returncode, 0, result.stderr)
        build, run = self.calls()
        self.assertEqual(build[:5], ["build", "-f", str(PACKAGING / "arch/Containerfile"), "-t", IMAGE])
        self.assertEqual(len(build), 6)
        self.assertEqual(
            run,
            ["run", "--rm", "--network=none", "--userns=keep-id", "-v", f"{BUILD}:/pkg:z", IMAGE, "makepkg", "--nodeps", "--noconfirm"],
        )

    def test_bad_deb_name_is_refused(self) -> None:
        for name in (
            "vaakora_1.2.3_amd64.deb",
            "Vaakora_1.2.3_arm64.deb",
            "Vaakora_1.2.3-rc1_amd64.deb",
            "Vaakora__amd64.deb",
            "Vaakora_1.2.3_amd64.deb.part",
            "Vaakora-1.2.3-1.x86_64.rpm",
        ):
            with self.subTest(name=name):
                deb = self.scratch / name
                shutil.copyfile(self.deb, deb)
                result = self.run_script(str(deb))
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("refusing:", result.stderr)
                self.assertFalse(self.trace.exists(), "podman ran")
        with self.subTest(name="relative path"):
            result = subprocess.run(
                [str(SCRIPT), self.deb.name, str(self.out)],
                cwd=self.scratch,
                env=self.environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertFalse(self.trace.exists(), "podman ran")
        self.assertEqual(list(self.out.iterdir()), [])

    def test_makepkg_failure_is_not_swallowed(self) -> None:
        result = self.run_script(str(self.deb), MAKEPKG_RC="4")
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertEqual(list(self.out.iterdir()), [])
        self.assertNotIn("built:", result.stdout)

    def test_pkgbuild_tracks_the_app_version(self) -> None:
        version = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())["version"]
        self.assertEqual(assignment(PKGBUILD.read_text(), "pkgver"), version)

    def test_pkgbuild_depends(self) -> None:
        depends = assignment(PKGBUILD.read_text(), "depends")
        self.assertEqual(tuple(re.findall(r"'([^']*)'", depends)), DEPENDS)


if __name__ == "__main__":
    unittest.main()
