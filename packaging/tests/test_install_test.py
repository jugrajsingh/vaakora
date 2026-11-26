import os
import shutil
import subprocess
import unittest
from pathlib import Path

from roots import PACKAGING, SCRATCH

INSTALL_TEST = PACKAGING / "install-test.sh"
SMOKE = PACKAGING / "install-smoke.sh"
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
        for name in FILES.values():
            (self.dist / name).write_text("package")
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

    def run_test(self, *targets: str, dist: Path | None = None, **environment: str) -> subprocess.CompletedProcess[str]:
        """Runs install-test.sh directly (its own mode bit) with VERSION 1.2.3 and remembers its log dir for cleanup."""
        result = subprocess.run(
            [str(INSTALL_TEST), str(dist or self.dist), "1.2.3", *targets],
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


if __name__ == "__main__":
    unittest.main()
