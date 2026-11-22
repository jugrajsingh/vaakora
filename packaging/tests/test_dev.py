import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from roots import PACKAGING, ROOT, SCRATCH


class DevDevicesTests(unittest.TestCase):
    def run_dev(self, *arguments):
        scratch = SCRATCH / "dev-device-fixtures"
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            path = Path(directory)
            capture = path / "arguments.json"
            tool = path / "podman"
            tool.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, sys\n"
                "from pathlib import Path\n"
                'if sys.argv[1] == "run":\n'
                '    Path(os.environ["CAPTURE"]).write_text(json.dumps(sys.argv[2:]))\n'
            )
            tool.chmod(0o755)
            env = os.environ | {
                "PATH": str(path) + ":" + os.environ["PATH"],
                "CAPTURE": str(capture),
            }
            result = subprocess.run(
                [str(PACKAGING / "dev.sh"), *arguments, str(ROOT), "true"],
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
            )
            return result, json.loads(capture.read_text()) if capture.exists() else None

    def test_runs_in_the_vaakora_image_with_vaakora_volumes(self):
        result, args = self.run_dev()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("vaakora-build:fedora45", args)
        volumes = [args[index + 1] for index, arg in enumerate(args) if arg == "-v"]
        self.assertIn("vaakora-cargo:/cache/cargo:z", volumes)
        self.assertIn("vaakora-bun:/cache/bun:z", volumes)
        self.assertIn("vaakora-ortcache:/home/builder/.cache:z", volumes)
        self.assertIn("vaakora-target:/cache/dev-target:z", volumes)

    def test_checkout_without_a_tauri_manifest_is_refused(self):
        scratch = SCRATCH / "dev-device-fixtures"
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            result = subprocess.run(
                [str(PACKAGING / "dev.sh"), directory, "true"],
                capture_output=True,
                text=True,
                timeout=10,
            )
        self.assertEqual(result.returncode, 2)

    def test_default_has_no_hardware_access(self):
        result, args = self.run_dev()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("--device", args)
        self.assertNotIn("keep-groups", args)
        self.assertNotIn("label=disable", args)

    @unittest.skipUnless(
        Path("/dev/dri/renderD128").is_char_device()
        and Path("/dev/accel/accel0").is_char_device(),
        "hardware character devices absent",
    )
    def test_opt_in_devices_have_group_access_and_exact_flags(self):
        result, args = self.run_dev(
            "--device", "/dev/dri/renderD128", "--device", "/dev/accel/accel0"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        devices = [args[index + 1] for index, arg in enumerate(args) if arg == "--device"]
        self.assertEqual(devices, ["/dev/dri/renderD128", "/dev/accel/accel0"])
        self.assertEqual(args[args.index("--group-add") + 1], "keep-groups")
        self.assertEqual(args[args.index("--security-opt") + 1], "label=disable")

    def test_unknown_device_is_refused_before_podman(self):
        result, args = self.run_dev("--device", "/dev/null")
        self.assertEqual(result.returncode, 2)
        self.assertIsNone(args)

    def test_read_only_mount_does_not_relabel_owner_files(self):
        mount = str(ROOT / "Cargo.toml") + ":/fixture"
        result, args = self.run_dev("--mount", mount)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(mount + ":ro", args)
        self.assertNotIn(mount + ":ro,z", args)
        self.assertNotIn(mount + ":ro,Z", args)


if __name__ == "__main__":
    unittest.main()
