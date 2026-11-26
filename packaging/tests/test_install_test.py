import hashlib
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from roots import PACKAGING, SCRATCH

INSTALL_TEST = PACKAGING / "install-test.sh"
SMOKE = PACKAGING / "install-smoke.sh"
INSTALLER = PACKAGING.parent / "docs/install.sh"
DIGEST = "sha256:" + "a" * 64
# (target, image, kind) in matrix order.
MATRIX = (
    ("fedora-44", "registry.fedoraproject.org/fedora:44", "rpm"),
    ("fedora-45", "registry.fedoraproject.org/fedora:45", "rpm"),
    ("debian-12", "docker.io/library/debian:12", "deb"),
    ("debian-13", "docker.io/library/debian:13", "deb"),
    ("ubuntu-22.04", "docker.io/library/ubuntu:22.04", "deb"),
    ("ubuntu-24.04", "docker.io/library/ubuntu:24.04", "deb"),
    ("ubuntu-26.04", "docker.io/library/ubuntu:26.04", "deb"),
    ("ubuntu-26.10", "docker.io/library/ubuntu:26.10", "deb"),
    ("arch", "docker.io/library/archlinux:latest", "arch"),
    ("appimage-fedora-45", "registry.fedoraproject.org/fedora:45", "appimage"),
    ("appimage-debian-12", "docker.io/library/debian:12", "appimage"),
    ("appimage-ubuntu-22.04", "docker.io/library/ubuntu:22.04", "appimage"),
    ("appimage-arch", "docker.io/library/archlinux:latest", "appimage"),
)
FILES = {
    "rpm": "Vaakora-1.2.3-1.x86_64.rpm",
    "deb": "Vaakora_1.2.3_amd64.deb",
    "arch": "vaakora-1.2.3-1-x86_64.pkg.tar.zst",
    "appimage": "Vaakora_1.2.3_amd64.AppImage",
}
# Records every call's argv (tab-separated, one call per line). FAIL_IMAGE fails the smoke, FAIL_PULL fails the pull.
PODMAN = r"""(IFS="$(printf '\t')"; printf '%s\n' "$*") >>"$PODMAN_ARGV"
case "$1" in
  pull)
    if [ "$3" = "${FAIL_PULL:-}" ]; then echo "pull failed" >&2; exit 125; fi ;;
  image) echo "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ;;
  run)
    case " $* " in
      *" ${FAIL_IMAGE:-no failure} bash "*) echo "SMOKE FAIL: x"; exit 1 ;;
    esac
    echo "SMOKE PASS" ;;
  *) exit 64 ;;
esac
"""


class InstallTestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scratch = SCRATCH / "install-test-fixture"
        shutil.rmtree(self.scratch, ignore_errors=True)
        self.scratch.mkdir(parents=True)
        self.bin = self.scratch / "bin"
        self.bin.mkdir()
        podman = self.bin / "podman"
        podman.write_text("#!/bin/sh\nset -eu\n" + PODMAN)
        podman.chmod(0o755)
        self.argv_file = self.scratch / "podman-argv"
        self.dist = self.scratch / "dist"
        self.dist.mkdir()
        for kind, name in FILES.items():
            (self.dist / name).write_text("package " + kind)
        self.environment = {
            **os.environ,
            "PATH": str(self.bin) + ":" + os.environ["PATH"],
            "PODMAN_ARGV": str(self.argv_file),
        }
        self.logs: list[Path] = []

    def tearDown(self) -> None:
        shutil.rmtree(self.scratch)
        for logs in self.logs:
            shutil.rmtree(logs, ignore_errors=True)

    def run_test(
        self, *targets: str, dist: Path | None = None, script: bool = False, **environment: str
    ) -> subprocess.CompletedProcess[str]:
        """Runs install-test.sh directly (its own mode bit) with VERSION 1.2.3 and remembers its log dir for cleanup."""
        result = subprocess.run(
            [str(INSTALL_TEST), *(["--script"] if script else []), str(dist or self.dist), "1.2.3", *targets],
            env={**self.environment, **environment},
            capture_output=True,
            text=True,
            timeout=60,
        )
        for line in result.stdout.splitlines():
            if line.startswith("logs: "):
                logs = Path(line.removeprefix("logs: "))
                self.assertTrue(logs.is_relative_to(PACKAGING / ".work/logs"), logs)
                self.logs.append(logs)
        return result

    def release(self) -> Path:
        """The release dir of the last --script run: it lives in that run's logs dir."""
        return self.logs[-1] / "release"

    def calls(self, verb: str) -> list[list[str]]:
        if not self.argv_file.exists():
            return []
        calls = [line.split("\t") for line in self.argv_file.read_text().splitlines()]
        return [call for call in calls if call[0] == verb]

    def verdicts(self, result: subprocess.CompletedProcess[str]) -> list[str]:
        return [line for line in result.stdout.splitlines() if line.startswith(("PASS ", "FAIL "))]

    def test_all_targets_pass(self) -> None:
        result = self.run_test()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            self.verdicts(result),
            [f"PASS {name} {image}@{DIGEST}" for name, image, _ in MATRIX],
        )
        self.assertEqual(len(self.calls("run")), 13)
        self.assertEqual([call[:3] for call in self.calls("pull")], [["pull", "-q", image] for _, image, _ in MATRIX])
        self.assertEqual(
            self.calls("image"),
            [["image", "inspect", "--format", "{{.Digest}}", image] for _, image, _ in MATRIX],
        )

    def test_one_failure_fails_the_run(self) -> None:
        result = self.run_test(FAIL_IMAGE="docker.io/library/debian:13")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        verdicts = self.verdicts(result)
        self.assertEqual(len(verdicts), 13)
        failed = [line for line in verdicts if line.startswith("FAIL ")]
        self.assertEqual(len(failed), 1, verdicts)
        prefix = f"FAIL debian-13 docker.io/library/debian:13@{DIGEST} (log: "
        self.assertTrue(failed[0].startswith(prefix), failed[0])
        log = Path(failed[0].removeprefix(prefix).removesuffix(")"))
        self.assertEqual(log.name, "debian-13.log")
        self.assertEqual(log.parent, self.logs[0])
        self.assertIn("SMOKE FAIL: x", log.read_text())
        self.assertEqual(verdicts[4], f"PASS ubuntu-22.04 docker.io/library/ubuntu:22.04@{DIGEST}")
        self.assertEqual(len(self.calls("run")), 13)

    def test_pull_failure_fails_that_target_only(self) -> None:
        result = self.run_test("debian-12", "arch", FAIL_PULL="docker.io/library/debian:12")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        verdicts = self.verdicts(result)
        self.assertEqual(len(verdicts), 2, verdicts)
        prefix = "FAIL debian-12 docker.io/library/debian:12@unknown (log: "
        self.assertTrue(verdicts[0].startswith(prefix), verdicts[0])
        self.assertEqual(verdicts[1], f"PASS arch docker.io/library/archlinux:latest@{DIGEST}")
        log = Path(verdicts[0].removeprefix(prefix).removesuffix(")"))
        self.assertIn("pull failed", log.read_text())
        self.assertEqual([call[-2] for call in self.calls("run")], ["arch"])

    def test_targets_can_be_selected(self) -> None:
        # Only the files the selected targets need have to be present.
        dist = self.scratch / "partial-dist"
        dist.mkdir()
        for kind in ("deb", "arch"):
            (dist / FILES[kind]).write_text("package")
        result = self.run_test("debian-12", "arch", dist=dist)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            self.verdicts(result),
            [
                f"PASS debian-12 docker.io/library/debian:12@{DIGEST}",
                f"PASS arch docker.io/library/archlinux:latest@{DIGEST}",
            ],
        )
        runs = self.calls("run")
        self.assertEqual(len(runs), 2)
        self.assertEqual(runs[0][-5:], ["docker.io/library/debian:12", "bash", "/smoke.sh", "deb", "/dist/" + FILES["deb"]])
        self.assertEqual(
            runs[1][-5:], ["docker.io/library/archlinux:latest", "bash", "/smoke.sh", "arch", "/dist/" + FILES["arch"]]
        )

    def test_unknown_target_and_missing_file_are_usage_errors(self) -> None:
        result = self.run_test("debian-12", "solaris-11")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("unknown target: solaris-11", result.stderr)
        (self.dist / FILES["rpm"]).unlink()
        result = self.run_test("debian-12", "fedora-45")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn(f"missing: {self.dist / FILES['rpm']}", result.stderr)
        result = self.run_test()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        result = self.run_test("appimage-fedora-45", dist=self.scratch / "absent")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        for argv in ([], [str(self.dist)]):
            result = subprocess.run(
                [str(INSTALL_TEST), *argv], env=self.environment, capture_output=True, text=True, timeout=60
            )
            self.assertEqual(result.returncode, 2, argv)
            self.assertIn("usage:", result.stderr)
        self.assertEqual(self.calls("run"), [])
        self.assertEqual(self.calls("pull"), [])

    def test_dist_is_mounted_read_only_and_nothing_else(self) -> None:
        result = self.run_test()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        runs = self.calls("run")
        self.assertEqual(len(runs), 13)
        for call in runs:
            mounts = [call[i + 1] for i, argument in enumerate(call) if argument == "-v"]
            self.assertEqual(mounts, [f"{self.dist}:/dist:ro,z", f"{SMOKE}:/smoke.sh:ro,z"])
            self.assertEqual(call[:4], ["run", "--rm", "--timeout", "1800"])
            for argument in call:
                self.assertFalse(argument.startswith(("--volume", "--mount", "--volumes-from", "--cgroups")), argument)

    def test_package_file_names(self) -> None:
        result = self.run_test()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        # FILES holds the four names the brief fixes for VERSION 1.2.3.
        expected = [["bash", "/smoke.sh", kind, "/dist/" + FILES[kind]] for _, _, kind in MATRIX]
        self.assertEqual([call[-4:] for call in self.calls("run")], expected)

    def test_default_mode_unchanged(self) -> None:
        result = self.run_test()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.logs[-1] / "release").exists())
        for call in self.calls("run"):
            self.assertNotIn("-e", call)
            self.assertNotIn("-c", call)
            self.assertEqual(call[-4:-2], ["bash", "/smoke.sh"])

    def test_script_mode_mounts_release_and_installer(self) -> None:
        result = self.run_test(script=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            self.verdicts(result),
            [f"PASS {name} {image}@{DIGEST}" for name, image, _ in MATRIX],
        )
        runs = self.calls("run")
        self.assertEqual(len(runs), 13)
        for call in runs:
            mounts = [call[i + 1] for i, argument in enumerate(call) if argument == "-v"]
            self.assertEqual(mounts, [f"{self.release()}:/dist:ro,z", f"{INSTALLER}:/install.sh:ro,z", f"{SMOKE}:/smoke.sh:ro,z"])
            self.assertEqual(call[:4], ["run", "--rm", "--timeout", "1800"])
            environment = [call[i + 1] for i, argument in enumerate(call) if argument == "-e"]
            self.assertEqual(environment, ["VAAKORA_RELEASE_URL=file:///dist"])
            for argument in call:
                self.assertFalse(argument.startswith(("--volume", "--mount", "--volumes-from", "--cgroups")), argument)

    def test_script_mode_container_runs_installer_twice_then_smokes_what_it_installed(self) -> None:
        result = self.run_test("debian-12", "appimage-arch", script=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for call, kind in zip(self.calls("run"), ("deb", "appimage")):
            body = call[call.index("-c") + 1]
            self.assertEqual(body.count(';sh /install.sh "$@"'), 2, body)
            self.assertIn("curl", body)
            self.assertIn("ca-certificates", body)
            self.assertIn("--installed", body)
            self.assertNotIn("/dist/", body)
            self.assertEqual(call[call.index("-c") - 1 :][0], "bash")
            self.assertEqual(call[call.index("-c") + 2 : call.index("-c") + 4], ["install", kind])

    def test_script_mode_container_command_is_strict_and_runs_the_expected_steps(self) -> None:
        result = self.run_test("debian-12", "arch", "appimage-arch", script=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for call, kind in zip(self.calls("run"), ("deb", "arch", "appimage")):
            body = call[call.index("-c") + 1]
            self.assertTrue(body.startswith("set -eu;"), body)
            self.assertIn("apt-get install -y --no-install-recommends curl ca-certificates", body)
            self.assertIn("pacman -Syu --noconfirm --needed curl ca-certificates", body)
            self.assertIn("dnf install -y ca-certificates", body)
            if kind == "appimage":
                self.assertIn("/root/.local/bin/vaakora", body)

    def test_script_mode_writes_sums_for_the_four_files(self) -> None:
        # Extra files in DIST_DIR (older releases, another SHA256SUMS) never reach the release dir.
        (self.dist / "Vaakora-0.0.1-1.x86_64.rpm").write_text("old")
        (self.dist / "SHA256SUMS").write_text("stale\n")
        result = self.run_test("arch", script=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(sorted(path.name for path in self.release().iterdir()), sorted([*FILES.values(), "SHA256SUMS"]))
        expected = sorted(
            f"{hashlib.sha256((self.dist / name).read_bytes()).hexdigest()}  {name}" for name in FILES.values()
        )
        self.assertEqual(sorted((self.release() / "SHA256SUMS").read_text().splitlines()), expected)
        for name in FILES.values():
            self.assertEqual((self.release() / name).read_bytes(), (self.dist / name).read_bytes())

    def test_script_mode_never_links_the_release_to_dist_files(self) -> None:
        result = self.run_test("arch", script=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for name in FILES.values():
            self.assertNotEqual((self.release() / name).stat().st_ino, (self.dist / name).stat().st_ino)

    def test_script_mode_appimage_targets_pass_flag(self) -> None:
        result = self.run_test(script=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for call, (name, _, kind) in zip(self.calls("run"), MATRIX):
            tail = call[call.index("-c") + 2 :]
            if kind == "appimage":
                self.assertEqual(tail, ["install", "appimage", "--appimage"], name)
            else:
                self.assertEqual(tail, ["install", kind], name)

    def test_script_mode_needs_all_four_files_and_is_a_usage_error_without_them(self) -> None:
        (self.dist / FILES["arch"]).unlink()
        result = self.run_test("debian-12", script=True)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn(f"missing: {self.dist / FILES['arch']}", result.stderr)
        result = self.run_test("solaris-11", script=True)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual(self.calls("run"), [])
        self.assertEqual(self.calls("pull"), [])

    def test_script_mode_failure_fails_the_run_with_a_log(self) -> None:
        result = self.run_test("debian-12", "arch", script=True, FAIL_IMAGE="docker.io/library/debian:12")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        verdicts = self.verdicts(result)
        prefix = f"FAIL debian-12 docker.io/library/debian:12@{DIGEST} (log: "
        self.assertTrue(verdicts[0].startswith(prefix), verdicts[0])
        self.assertEqual(verdicts[1], f"PASS arch docker.io/library/archlinux:latest@{DIGEST}")
        self.assertEqual(len(self.calls("run")), 2)

    def test_smoke_refuses_bad_arguments_before_doing_anything(self) -> None:
        # Direct invocation on the host: every refusal here happens before the smoke reads /etc/os-release or installs.
        usage = "SMOKE FAIL: usage: install-smoke.sh rpm|deb|arch|appimage FILE"
        for argv, reason in (
            ([], usage),
            (["zip", str(self.dist / FILES["deb"])], usage),
            (["deb", str(self.scratch / "absent.deb")], f"SMOKE FAIL: no such file: {self.scratch / 'absent.deb'}"),
        ):
            result = subprocess.run([str(SMOKE), *argv], env=self.environment, capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 1, argv)
            self.assertEqual(result.stdout.splitlines()[-1], reason)


# Stub ldd, keyed by file name; exits 0 like real ldd does on a missing symbol version.
# LDD_MODE: both (default) breaks libplugin.so's symbol version and libmissing.so's library, version only the first,
# clean nothing.
LDD = r"""f=$1
name=${f##*/}
mode=${LDD_MODE:-both}
if [ "$mode" != clean ]; then
  case "$name" in
    libplugin.so)
      dep="${f%/*}/libdep.so"
      echo "$f: $dep: version \`ABI_2' not found (required by $f)"
      echo "$f: $dep: version \`ABI_2' not found (required by $f)"
      printf '\tlinux-vdso.so.1 (0x00007f0000000000)\n\tlibdep.so => %s (0x00007f0000001000)\n' "$dep"
      exit 0 ;;
    libmissing.so)
      if [ "$mode" = version ]; then printf '\tlibc.so.6 => /lib64/libc.so.6 (0x00007f0000002000)\n'; exit 0; fi
      printf '\tlinux-vdso.so.1 (0x00007f0000000000)\n\tlibOpenCL.so.1 => not found\n'
      exit 0 ;;
  esac
fi
printf '\tlinux-vdso.so.1 (0x00007f0000000000)\n\tlibc.so.6 => /lib64/libc.so.6 (0x00007f0000002000)\n'
"""


class SmokeLddTests(unittest.TestCase):
    """The smoke's ldd scan, run on a fixture tree through a copy of install-smoke.sh whose only change is its root."""

    def setUp(self) -> None:
        self.scratch = SCRATCH / "install-smoke-fixture"
        shutil.rmtree(self.scratch, ignore_errors=True)
        self.root = self.scratch / "root"
        lib = self.root / "usr/lib/Vaakora"
        executables = {
            self.scratch / "bin/dnf": "exit 0",
            self.scratch / "bin/rpm": 'echo "$*" >>"$SMOKE_FIXTURE_ROOT/../rpm-calls"; exit "${RPM_EXIT:-0}"',
            self.scratch / "bin/vaakora": "echo 'Usage: vaakora [OPTIONS]'",
            self.scratch / "bin/ldd": LDD,
            lib / "llm/llama-server": "echo 'version: 1 (fixture)'",
            lib / "tts/vaakora-tts": """echo '{"openvino":"2026.4.1-fixture","available":["CPU"]}'""",
        }
        for path, code in executables.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("#!/bin/sh\nset -eu\n" + code + "\n")
            path.chmod(0o755)
        # ELF stand-ins: only the magic matters to the smoke, the stub ldd answers by name.
        for path in (self.root / "usr/bin/vaakora", lib / "libdep.so", lib / "libplugin.so", lib / "libmissing.so"):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"\x7fELF fixture")
        smoke = SMOKE.read_text()
        relocated = smoke.replace("\nroot=\n", '\nroot="$SMOKE_FIXTURE_ROOT"\n')
        self.assertEqual(relocated.count('root="$SMOKE_FIXTURE_ROOT"'), 1)
        self.smoke = self.scratch / "install-smoke.sh"
        self.smoke.write_text(relocated)
        self.package = self.scratch / "Vaakora-1.2.3-1.x86_64.rpm"
        self.package.write_text("package")
        self.environment = {
            **os.environ,
            "PATH": str(self.scratch / "bin") + ":" + os.environ["PATH"],
            "SMOKE_FIXTURE_ROOT": str(self.root),
        }

    def tearDown(self) -> None:
        shutil.rmtree(self.scratch)

    def smoke_run(self, *argv: str, **environment: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(self.smoke), *(argv or ("rpm", str(self.package)))],
            env={**self.environment, **environment},
            capture_output=True,
            text=True,
            timeout=60,
        )

    def test_missing_symbol_version_and_missing_library_fail_the_smoke(self) -> None:
        result = self.smoke_run()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        plugin = self.root / "usr/lib/Vaakora/libplugin.so"
        dep = self.root / "usr/lib/Vaakora/libdep.so"
        missing = self.root / "usr/lib/Vaakora/libmissing.so"
        version = f"{plugin}: {plugin}: {dep}: version `ABI_2' not found (required by {plugin})"
        library = f"{missing}: libOpenCL.so.1 => not found"
        lines = result.stdout.splitlines()
        # Each file and diagnostic once, though the stub ldd repeats the version line.
        unresolved = sorted(line for line in lines if line.startswith("UNRESOLVED "))
        self.assertEqual(unresolved, sorted([f"UNRESOLVED {version}", f"UNRESOLVED {library}"]))
        self.assertIn("== ldd: 4 ELF files, 2 unresolved", lines)
        self.assertTrue(lines[-1].startswith("SMOKE FAIL: unresolved libraries: "), lines[-1])
        self.assertIn(version, lines[-1])
        self.assertIn(library, lines[-1])

    def test_missing_symbol_version_alone_fails_the_smoke(self) -> None:
        # The SONAME resolves and ldd exits 0; only the "version ... not found" line tells.
        result = self.smoke_run(LDD_MODE="version")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        plugin = self.root / "usr/lib/Vaakora/libplugin.so"
        dep = self.root / "usr/lib/Vaakora/libdep.so"
        lines = result.stdout.splitlines()
        self.assertIn("== ldd: 4 ELF files, 1 unresolved", lines)
        self.assertEqual(
            lines[-1],
            f"SMOKE FAIL: unresolved libraries: {plugin}: {plugin}: {dep}: version `ABI_2' not found (required by {plugin})",
        )

    def test_resolved_libraries_pass_the_smoke(self) -> None:
        result = self.smoke_run(LDD_MODE="clean")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        lines = result.stdout.splitlines()
        self.assertIn("== ldd: 4 ELF files, 0 unresolved", lines)
        self.assertEqual(lines[-1], "SMOKE PASS")

    def test_installed_mode_checks_the_package_without_installing_it(self) -> None:
        # dnf would fail the run if the smoke called it; the package is only queried.
        dnf = self.scratch / "bin/dnf"
        dnf.write_text("#!/bin/sh\necho dnf was called >&2\nexit 1\n")
        result = self.smoke_run("--installed", "rpm", LDD_MODE="clean")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.splitlines()[-1], "SMOKE PASS")
        self.assertEqual((self.scratch / "rpm-calls").read_text(), "-q vaakora\n")

    def test_installed_mode_fails_when_the_package_is_not_installed(self) -> None:
        result = self.smoke_run("--installed", "rpm", LDD_MODE="clean", RPM_EXIT="1")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertTrue(result.stdout.splitlines()[-1].startswith("SMOKE FAIL: "), result.stdout)
        self.assertIn("rpm -q vaakora", result.stdout.splitlines()[-1])

    def test_installed_mode_refuses_bad_arguments(self) -> None:
        usage = "SMOKE FAIL: usage: install-smoke.sh --installed rpm|deb|arch|appimage [FILE] (FILE is required for appimage)"
        for argv in (
            ["--installed"],
            ["--installed", "zip"],
            ["--installed", "appimage"],
            ["--installed", "rpm", str(self.package), "extra"],
        ):
            result = self.smoke_run(*argv)
            self.assertEqual(result.returncode, 1, argv)
            self.assertEqual(result.stdout.splitlines()[-1], usage, argv)
        result = self.smoke_run("--installed", "appimage", str(self.scratch / "absent"))
        self.assertEqual(result.stdout.splitlines()[-1], f"SMOKE FAIL: no such file: {self.scratch / 'absent'}")


if __name__ == "__main__":
    unittest.main()
