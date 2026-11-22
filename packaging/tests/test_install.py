import os
from pathlib import Path
import shutil
import subprocess
import unittest

from roots import PACKAGING, SCRATCH


class InstallTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scratch = SCRATCH / "install-fixture"
        shutil.rmtree(self.scratch, ignore_errors=True)
        self.scratch.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.repo = self.scratch / "repo"
        (self.repo / "packaging/dist").mkdir(parents=True)
        (self.repo / "src-tauri").mkdir()
        for name in ("install.sh", "lib.sh"):
            shutil.copyfile(PACKAGING / name, self.repo / "packaging" / name)
        (self.repo / "src-tauri/Cargo.toml").write_text(
            '[workspace]\nmembers = []\n\n[package]\nname = "fixapp"\nversion = "1.0.0"\n\n[dependencies]\nname = "decoy"\n'
        )
        (self.repo / "src-tauri/tauri.conf.json").write_text('{"version": "1.0.0"}\n')
        self.home = self.scratch / "home"
        self.home.mkdir()
        self.bin = self.scratch / "bin"
        self.bin.mkdir()
        rpm = self.bin / "rpm"
        rpm.write_text(
            "#!/usr/bin/env python3\n"
            "import os, sys\n"
            "from pathlib import Path\n"
            "args = sys.argv[1:]\n"
            'if args[:1] == ["-qp"]:\n'
            '    parts = Path(args[-1]).stem.split("_")\n'
            '    if len(parts) < 2:\n'
            "        sys.exit(1)\n"
            '    print(parts[0] + " " + parts[1])\n'
            'elif args == ["-q", "fixapp"]:\n'
            '    sys.exit(0 if os.environ.get("INSTALLED") else 1)\n'
            'elif args == ["-q", "--qf", "%{VERSION}", "fixapp"]:\n'
            '    print(os.environ["INSTALLED"])\n'
            "else:\n"
            "    sys.exit(99)\n"
        )
        rpm.chmod(0o755)
        for name in ("sudo", "dnf", "systemctl"):
            tool = self.bin / name
            tool.write_text("#!/usr/bin/env bash\nexit 99\n")
            tool.chmod(0o755)
        self.env = {**os.environ, "HOME": str(self.home), "PATH": str(self.bin) + ":" + os.environ["PATH"]}

    def rpm_file(self, name: str, mtime: int) -> Path:
        path = self.repo / "packaging/dist" / name
        path.touch()
        os.utime(path, (mtime, mtime))
        return path

    def select(self, version: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", "-c", 'source "$1"; select_rpm "$2" fixapp "$3"', "_", str(self.repo / "packaging/lib.sh"), str(self.repo / "packaging/dist"), version],
            capture_output=True,
            text=True,
            env=self.env,
        )

    def install(self, installed: str = "") -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(self.repo / "packaging/install.sh"), "--dry-run"],
            capture_output=True,
            text=True,
            env={**self.env, "INSTALLED": installed},
        )

    def test_select_rpm_picks_the_newest_matching_name_and_version_and_skips_unreadable(self) -> None:
        self.rpm_file("fixapp_1.0.0_a.rpm", 1000)
        newest = self.rpm_file("fixapp_1.0.0_b.rpm", 2000)
        self.rpm_file("fixapp_2.0.0_c.rpm", 3000)
        self.rpm_file("other_1.0.0_d.rpm", 4000)
        self.rpm_file("unreadable.rpm", 5000)
        result = self.select("1.0.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), str(newest))
        self.assertIn("skipping unreadable rpm", result.stderr)
        self.assertEqual(self.select("9.9.9").returncode, 1)

    def test_dry_run_prints_the_dnf_action_and_writes_nothing(self) -> None:
        rpm = self.rpm_file("fixapp_1.0.0_a.rpm", 1000)
        before = sorted(p.name for p in self.repo.rglob("*"))
        for installed, action in (("", "install"), ("0.9.0", "upgrade"), ("1.0.0", "reinstall"), ("2.0.0", "downgrade")):
            with self.subTest(installed=installed):
                result = self.install(installed)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"-> {action}", result.stdout)
                self.assertIn(f"sudo dnf {action} --nogpgcheck -y {rpm}", result.stdout)
                self.assertEqual(list(self.home.iterdir()), [])
                self.assertEqual(sorted(p.name for p in self.repo.rglob("*")), before)

    def test_no_matching_rpm_is_refused(self) -> None:
        self.rpm_file("fixapp_2.0.0_a.rpm", 1000)
        result = self.install()
        self.assertEqual(result.returncode, 1)
        self.assertIn("refusing:", result.stderr)
        self.assertNotIn("dnf", result.stdout)

    def test_unknown_argument_exits_2(self) -> None:
        result = subprocess.run(
            ["bash", str(self.repo / "packaging/install.sh"), "--bogus"],
            capture_output=True,
            text=True,
            env=self.env,
        )
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
