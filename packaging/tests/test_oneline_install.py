"""Unit tests for docs/install.sh, the one-line installer.

The script is piped to `sh` exactly as `curl ... | sh` does. Every command it
could use for a side effect (curl, wget, sudo, dnf, apt, pacman, uname, getconf,
id, ldconfig, ldd) is a small shell fake on a private PATH that appends its argv
to a log; the rest of the PATH is a directory of symlinks to the host tools the
script needs, so a real dnf, apt, curl or sudo on the host can never be reached.
"""
import fcntl
import hashlib
import os
from pathlib import Path
import pty
import shutil
import subprocess
import tempfile
import termios
import unittest

from roots import ROOT, SCRATCH

SCRIPT = ROOT / "docs/install.sh"
SH = shutil.which("sh") or "/bin/sh"
LATEST = "https://github.com/jugrajsingh/vaakora/releases/latest/download"
PINNED = "https://github.com/jugrajsingh/vaakora/releases/download/v9.9.9"
ASSETS = {
    "rpm": "Vaakora-9.9.9-1.x86_64.rpm",
    "deb": "Vaakora_9.9.9_amd64.deb",
    "arch": "vaakora-9.9.9-1-x86_64.pkg.tar.zst",
    "appimage": "Vaakora_9.9.9_amd64.AppImage",
}
HOST_TOOLS = (
    "basename cat chmod cp cut dirname grep head install ls mkdir mktemp mv "
    "rm sed sha256sum stat tail tr wc"
).split()

FAKE_CURL = """#!/bin/sh
echo "curl $*" >> "$FAKE_LOG"
url=
out=
while [ $# -gt 0 ]; do
  case $1 in
    -o) out=$2; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
cp "$FAKE_RELEASE/${url##*/}" "$out" || exit 22
"""
FAKE_WGET = """#!/bin/sh
echo "wget $*" >> "$FAKE_LOG"
out=
url=
while [ $# -gt 0 ]; do
  case $1 in
    -qO) out=$2; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
cp "$FAKE_RELEASE/${url##*/}" "$out" || exit 8
"""
FAKE_SUDO = """#!/bin/sh
echo "sudo $*" >> "$FAKE_LOG"
exec "$@"
"""
FAKE_PM = """#!/bin/sh
echo "FAKE_NAME $*" >> "$FAKE_LOG"
if [ -t 0 ]; then echo tty >> "$FAKE_STDIN"; else echo notty >> "$FAKE_STDIN"; fi
for arg in "$@"; do
  case $arg in
    /*)
      [ -r "$arg" ] || exit 5
      stat -c %a "$(dirname "$arg")" >> "$FAKE_MODES"
      ;;
  esac
done
exit "${FAKE_PM_EXIT:-0}"
"""
FAKE_UNAME = """#!/bin/sh
echo "uname $*" >> "$FAKE_LOG"
case $1 in
  -m) echo "${FAKE_UNAME_M:-x86_64}" ;;
  *) echo "${FAKE_UNAME_S:-Linux}" ;;
esac
"""
FAKE_GETCONF = """#!/bin/sh
echo "getconf $*" >> "$FAKE_LOG"
[ -z "${FAKE_NO_GETCONF:-}" ] || exit 1
echo "glibc ${FAKE_GLIBC:-2.39}"
"""
FAKE_LDD = """#!/bin/sh
echo "ldd $*" >> "$FAKE_LOG"
echo "ldd (GNU libc) ${FAKE_GLIBC:-2.39}"
"""
FAKE_ID = """#!/bin/sh
echo "id $*" >> "$FAKE_LOG"
echo "${FAKE_UID:-1000}"
"""
FAKE_LDCONFIG = """#!/bin/sh
echo "ldconfig $*" >> "$FAKE_LOG"
echo "	libc.so.6 (libc6,x86-64) => /lib64/libc.so.6"
[ -n "${FAKE_NO_FUSE:-}" ] || echo "	libfuse.so.2 (libc6,x86-64) => /lib64/libfuse.so.2"
"""


class OnelineInstallTests(unittest.TestCase):
    def setUp(self) -> None:
        base = SCRATCH / "oneline-install"
        base.mkdir(parents=True, exist_ok=True)
        self.scratch = Path(tempfile.mkdtemp(dir=base))
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.bin = self.scratch / "bin"
        self.tools = self.scratch / "tools"
        self.release = self.scratch / "release"
        self.home = self.scratch / "home"
        self.tmp = self.scratch / "tmp"
        for path in (self.bin, self.tools, self.release, self.home, self.tmp):
            path.mkdir()
        self.log = self.scratch / "calls.log"
        self.stdin_log = self.scratch / "stdin.log"
        self.modes = self.scratch / "modes.log"
        for path in (self.log, self.stdin_log, self.modes):
            path.touch()
        self.os_release = self.scratch / "os-release"
        for name in HOST_TOOLS:
            found = shutil.which(name)
            self.assertIsNotNone(found, name)
            (self.tools / name).symlink_to(found)
        for name, body in (
            ("curl", FAKE_CURL),
            ("wget", FAKE_WGET),
            ("sudo", FAKE_SUDO),
            ("uname", FAKE_UNAME),
            ("getconf", FAKE_GETCONF),
            ("ldd", FAKE_LDD),
            ("id", FAKE_ID),
            ("ldconfig", FAKE_LDCONFIG),
        ):
            self.fake(name, body)
        for name in ("dnf", "apt", "pacman"):
            self.fake(name, FAKE_PM.replace("FAKE_NAME", name))
        self.write_release()
        self.env = {
            "HOME": str(self.home),
            "PATH": f"{self.bin}:{self.tools}",
            "TMPDIR": str(self.tmp),
            "LANG": "C",
            "WAYLAND_DISPLAY": "wayland-0",
            "VAAKORA_OS_RELEASE": str(self.os_release),
            "FAKE_LOG": str(self.log),
            "FAKE_STDIN": str(self.stdin_log),
            "FAKE_MODES": str(self.modes),
            "FAKE_RELEASE": str(self.release),
        }

    def fake(self, name: str, body: str) -> None:
        path = self.bin / name
        path.write_text(body)
        path.chmod(0o755)

    def write_release(self, skip: str | None = None) -> None:
        sums = []
        for kind, name in ASSETS.items():
            data = f"fixture {name}\n".encode()
            (self.release / name).write_bytes(data)
            if kind != skip:
                sums.append(f"{hashlib.sha256(data).hexdigest()}  {name}\n")
        (self.release / "SHA256SUMS").write_text("".join(sums))

    def run_script(
        self,
        *args: str,
        os_release: str = "ID=fedora\n",
        extra: dict[str, str] | None = None,
        drop: tuple[str, ...] = (),
    ) -> subprocess.CompletedProcess[str]:
        self.os_release.write_text(os_release)
        env = {**self.env, **(extra or {})}
        for key in drop:
            env.pop(key, None)
        return subprocess.run(
            [SH, "-s", "--", *args],
            input=SCRIPT.read_text(),
            capture_output=True,
            text=True,
            env=env,
            start_new_session=True,
        )

    def calls(self) -> list[str]:
        return self.log.read_text().splitlines()

    def called(self, tool: str) -> list[str]:
        return [line for line in self.calls() if line.startswith(tool + " ")]

    def reset(self) -> None:
        self.log.write_text("")
        self.stdin_log.write_text("")
        self.modes.write_text("")
        shutil.rmtree(self.home / ".local", ignore_errors=True)

    def assert_installed(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.splitlines()[-1].startswith("Vaakora is installed"), result.stdout)

    def assert_install_command(
        self,
        result: subprocess.CompletedProcess[str],
        kind: str,
        tool: str,
        flag: str,
        *,
        sudo: bool = True,
    ) -> None:
        self.assert_installed(result)
        verb = "-U" if tool == "pacman" else "install"
        prefix = f"{'sudo ' if sudo else ''}{tool} {verb} {self.tmp}/vaakora."
        matches = [line for line in self.calls() if line.startswith(prefix)]
        self.assertEqual(len(matches), 1, self.calls())
        self.assertTrue(matches[0].endswith(f"/{ASSETS[kind]} {flag}"), matches[0])
        if not sudo:
            self.assertEqual(self.called("sudo"), [])

    def assert_appimage(self, result: subprocess.CompletedProcess[str]) -> None:
        self.assert_installed(result)
        target = self.home / ".local/bin/vaakora"
        self.assertTrue(os.access(target, os.X_OK))
        self.assertEqual(target.read_text(), f"fixture {ASSETS['appimage']}\n")
        for tool in ("sudo", "dnf", "apt", "pacman"):
            self.assertEqual(self.called(tool), [], tool)

    def downloads(self) -> list[str]:
        return [token for line in self.called("curl") for token in line.split() if "://" in token]

    def test_fedora_installs_rpm_with_sudo_dnf(self) -> None:
        result = self.run_script()
        self.assert_install_command(result, "rpm", "dnf", "-y")
        self.assertIn("sudo dnf remove vaakora", result.stdout)

    def test_id_like_picks_format(self) -> None:
        cases = (
            ("linuxmint", 'ID=linuxmint\nID_LIKE="ubuntu debian"\n', ("deb", "apt", "-y")),
            ("nobara", "ID=nobara\nID_LIKE=fedora\n", ("rpm", "dnf", "-y")),
            ("rocky", 'ID="rocky"\nID_LIKE="rhel centos fedora"\n', ("rpm", "dnf", "-y")),
            ("manjaro", "ID=manjaro\nID_LIKE=arch\n", ("arch", "pacman", "--noconfirm")),
            ("opensuse-tumbleweed", 'ID=opensuse-tumbleweed\nID_LIKE="opensuse suse"\n', None),
            ("debian", "ID=debian\n", ("deb", "apt", "-y")),
            ("arch", "ID=arch\n", ("arch", "pacman", "--noconfirm")),
        )
        for name, os_release, expected in cases:
            with self.subTest(name):
                self.reset()
                result = self.run_script(os_release=os_release)
                if expected is None:
                    self.assert_appimage(result)
                else:
                    self.assert_install_command(result, *expected)

    def test_rpm_distribution_without_dnf_gets_appimage(self) -> None:
        (self.bin / "dnf").unlink()
        self.assert_appimage(self.run_script())

    def test_appimage_flag_forces_appimage(self) -> None:
        self.assert_appimage(self.run_script("--appimage"))

    def test_unknown_option_is_refused(self) -> None:
        result = self.run_script("--frobnicate")
        self.assertEqual(result.returncode, 1)
        self.assertIn("vaakora: ", result.stderr)
        self.assertEqual(self.called("curl"), [])

    def test_root_runs_without_sudo(self) -> None:
        (self.bin / "sudo").unlink()
        result = self.run_script(extra={"FAKE_UID": "0"})
        self.assert_install_command(result, "rpm", "dnf", "-y", sudo=False)

    def test_non_root_without_sudo_refuses_before_download(self) -> None:
        (self.bin / "sudo").unlink()
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn("vaakora: ", result.stderr)
        self.assertIn("sudo", result.stderr)
        self.assertEqual(self.called("curl"), [])

    def test_default_url_is_latest(self) -> None:
        self.assert_installed(self.run_script())
        self.assertEqual(self.downloads(), [f"{LATEST}/SHA256SUMS", f"{LATEST}/{ASSETS['rpm']}"])

    def test_version_pins_release(self) -> None:
        self.assert_installed(self.run_script(extra={"VAAKORA_VERSION": "9.9.9"}))
        self.assertEqual(self.downloads(), [f"{PINNED}/SHA256SUMS", f"{PINNED}/{ASSETS['rpm']}"])

    def test_release_url_overrides(self) -> None:
        base = "https://mirror.example/vaakora"
        self.assert_installed(self.run_script(extra={"VAAKORA_RELEASE_URL": base, "VAAKORA_VERSION": "1.2.3"}))
        self.assertEqual(self.downloads(), [f"{base}/SHA256SUMS", f"{base}/{ASSETS['rpm']}"])

    def test_wget_used_without_curl(self) -> None:
        (self.bin / "curl").unlink()
        self.assert_installed(self.run_script())
        self.assertEqual(len(self.called("wget")), 2, self.calls())
        self.assertIn("-qO", self.called("wget")[0])

    def test_needs_curl_or_wget(self) -> None:
        (self.bin / "curl").unlink()
        (self.bin / "wget").unlink()
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn("vaakora: ", result.stderr)
        self.assertIn("needs curl or wget", result.stderr)

    def test_checksum_mismatch_refuses(self) -> None:
        (self.release / ASSETS["rpm"]).write_text("tampered\n")
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn("vaakora: ", result.stderr)
        self.assertIn("checksum", result.stderr)
        self.assertEqual(self.called("dnf"), [])
        self.assertEqual(self.called("sudo"), [])

    def test_refuses_non_linux_and_non_x86_64(self) -> None:
        result = self.run_script(extra={"FAKE_UNAME_S": "Darwin"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("coming soon", result.stderr)
        self.assertIn("https://github.com/jugrajsingh/vaakora#install", result.stderr)
        self.assertEqual(self.called("curl"), [])
        result = self.run_script(extra={"FAKE_UNAME_M": "aarch64"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("vaakora: ", result.stderr)
        self.assertEqual(self.called("curl"), [])
        self.assert_installed(self.run_script(extra={"FAKE_UNAME_M": "amd64"}))

    def test_old_glibc_refused_before_download(self) -> None:
        result = self.run_script(extra={"FAKE_GLIBC": "2.34"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("2.35", result.stderr)
        self.assertEqual(self.called("curl"), [])
        self.assert_installed(self.run_script(extra={"FAKE_GLIBC": "2.35"}))

    def test_glibc_falls_back_to_ldd(self) -> None:
        result = self.run_script(extra={"FAKE_NO_GETCONF": "1", "FAKE_GLIBC": "2.34"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("2.35", result.stderr)
        self.assertEqual(len(self.called("ldd")), 1)
        self.assertEqual(self.called("curl"), [])
        self.reset()
        self.assert_installed(self.run_script(extra={"FAKE_NO_GETCONF": "1", "FAKE_GLIBC": "2.39"}))

    def test_no_session_warns_and_continues(self) -> None:
        result = self.run_script(drop=("WAYLAND_DISPLAY", "DISPLAY"))
        self.assert_installed(result)
        self.assertIn("desktop app", result.stdout + result.stderr)
        self.reset()
        result = self.run_script()
        self.assertNotIn("desktop app", result.stdout + result.stderr)

    def test_missing_sums_entry_refuses(self) -> None:
        self.write_release(skip="deb")
        result = self.run_script(os_release="ID=debian\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("vaakora: ", result.stderr)
        self.assertEqual(self.called("apt"), [])

    def test_failed_package_manager_is_reported(self) -> None:
        result = self.run_script(extra={"FAKE_PM_EXIT": "1"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("vaakora: ", result.stderr)
        self.assertNotIn("Vaakora is installed", result.stdout)

    def test_package_directory_is_readable_by_the_apt_user(self) -> None:
        self.assert_installed(self.run_script(os_release="ID=ubuntu\n"))
        self.assertEqual(self.modes.read_text().split(), ["755"])

    def test_without_a_tty_the_package_manager_gets_no_stdin(self) -> None:
        self.assert_installed(self.run_script())
        self.assertEqual(self.stdin_log.read_text().split(), ["notty"])

    def test_with_a_tty_prompts_read_from_it(self) -> None:
        self.os_release.write_text("ID=fedora\n")
        master, slave = pty.openpty()
        self.addCleanup(os.close, master)
        self.addCleanup(os.close, slave)

        def controlling_tty() -> None:
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

        # preexec_fn runs after setsid(), so the child can adopt the pty as its controlling terminal.
        result = subprocess.run(
            [SH, "-s", "--"],
            input=SCRIPT.read_text(),
            capture_output=True,
            text=True,
            env=self.env,
            start_new_session=True,
            preexec_fn=controlling_tty,
        )
        self.assert_installed(result)
        install = [line for line in self.calls() if line.startswith("sudo dnf install ")]
        self.assertEqual(len(install), 1)
        self.assertFalse(install[0].endswith(" -y"), install[0])
        self.assertEqual(self.stdin_log.read_text().split(), ["tty"])

    def test_appimage_hints_for_path_and_fuse(self) -> None:
        result = self.run_script("--appimage", extra={"FAKE_NO_FUSE": "1"})
        self.assert_installed(result)
        self.assertIn("not on your PATH", result.stdout)
        self.assertIn("FUSE 2", result.stdout)
        self.assertIn("rm ~/.local/bin/vaakora", result.stdout)
        self.reset()
        result = self.run_script("--appimage", extra={"PATH": f"{self.home}/.local/bin:{self.bin}:{self.tools}"})
        self.assert_installed(result)
        self.assertNotIn("not on your PATH", result.stdout)
        self.assertNotIn("FUSE 2", result.stdout)

    def test_truncated_script_has_no_side_effects(self) -> None:
        text = SCRIPT.read_text()
        lines = text.splitlines(keepends=True)
        self.assertEqual(lines[-1].strip(), 'main "$@"')
        data = text.encode()
        starts = [0]
        for line in lines[:-1]:
            starts.append(starts[-1] + len(line.encode()))
        self.os_release.write_text("ID=fedora\n")
        for start in starts:
            with self.subTest(prefix=start):
                subprocess.run([SH, "-s", "--"], input=data[:start], capture_output=True, env=self.env, start_new_session=True, check=False)
                self.assertEqual(self.calls(), [])
                self.assertEqual(list(self.tmp.iterdir()), [])
                self.assertFalse((self.home / ".local").exists())

    def test_temp_dir_removed(self) -> None:
        self.assert_installed(self.run_script())
        self.assertEqual(list(self.tmp.iterdir()), [])
        (self.release / ASSETS["rpm"]).write_text("tampered\n")
        self.assertEqual(self.run_script().returncode, 1)
        self.assertEqual(list(self.tmp.iterdir()), [])
        self.write_release()
        self.assertEqual(self.run_script(extra={"FAKE_PM_EXIT": "1"}).returncode, 1)
        self.assertEqual(list(self.tmp.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
