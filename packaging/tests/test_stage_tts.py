import os
from pathlib import Path
import shutil
import subprocess
import unittest

from roots import PACKAGING, SCRATCH

NOTICES = (
    "LICENSE",
    "licensing/runtime-third-party-programs.txt",
    "licensing/onetbb_third-party-programs.txt",
    "licensing/onednn_third-party-programs.txt",
)
REQUIRED = (
    "libopenvino.so.2641",
    "libopenvino_c.so.2641",
    "libopenvino_onnx_frontend.so.2641",
    "libopenvino_ir_frontend.so.2641",
    "libopenvino_intel_cpu_plugin.so",
    "libopenvino_intel_gpu_plugin.so",
    "libopenvino_intel_npu_plugin.so",
    "libtbb.so.12",
    "libhwloc.so.15",
)


class StageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scratch = SCRATCH / "stage-fixture"
        shutil.rmtree(self.scratch, ignore_errors=True)
        self.runtime = self.scratch / "runtime"
        self.runtime.mkdir(parents=True)
        self.worker = self.scratch / "worker"
        self.worker.write_text("#!/bin/sh\nexit 0\n")
        self.worker.chmod(0o755)
        for library in REQUIRED:
            (self.runtime / library).write_bytes(b"fixture-ELF")
        self.staging = self.scratch / "stage"
        self.notices = self.scratch / "notices"
        for name in NOTICES:
            path = self.notices / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture notice")

    def tearDown(self) -> None:
        shutil.rmtree(self.scratch)

    def run_stage(self, *args: Path | str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(PACKAGING / "stage-tts.sh"), *map(str, args)],
            capture_output=True,
            text=True,
        )

    def test_complete_runtime_stages_worker_and_plugins_without_driver(self) -> None:
        (self.runtime / "libze_intel_npu.so.1").write_bytes(b"must-not-bundle")
        result = self.run_stage(self.worker, self.runtime, self.staging, self.notices)
        self.assertEqual(result.returncode, 0, result.stderr)
        destination = self.staging / "usr/lib/Handy/tts"
        self.assertEqual(
            {p.name for p in destination.iterdir()},
            set(REQUIRED) | {"handy-tts", "notices"},
        )
        self.assertTrue(os.access(destination / "handy-tts", os.X_OK))

    def test_existing_driver_in_destination_is_refused(self) -> None:
        destination = self.staging / "usr/lib/Handy/tts"
        destination.mkdir(parents=True)
        (destination / "libze_intel_npu.so.1").write_bytes(b"must-not-bundle")
        self.assertEqual(
            self.run_stage(
                self.worker, self.runtime, self.staging, self.notices
            ).returncode,
            1,
        )

    def test_every_required_runtime_library_is_a_guard(self) -> None:
        for library in REQUIRED:
            with self.subTest(library=library):
                path = self.runtime / library
                data = path.read_bytes()
                path.unlink()
                self.assertEqual(
                    self.run_stage(
                        self.worker, self.runtime, self.staging, self.notices
                    ).returncode,
                    1,
                )
                path.write_bytes(data)

    def test_every_notice_is_required_and_preserved(self) -> None:
        for name in NOTICES:
            path = self.notices / name
            path.unlink()
            self.assertEqual(
                self.run_stage(
                    self.worker, self.runtime, self.staging, self.notices
                ).returncode,
                1,
            )
            path.write_text("fixture notice")
        self.assertEqual(
            self.run_stage(
                self.worker, self.runtime, self.staging, self.notices
            ).returncode,
            0,
        )
        for name in NOTICES:
            self.assertEqual(
                (self.staging / "usr/lib/Handy/tts/notices" / name).read_text(),
                "fixture notice",
            )

    def test_bare_invocation_relative_root_and_nonexecutable_worker_are_refused(
        self,
    ) -> None:
        self.assertEqual(self.run_stage().returncode, 2)
        self.assertEqual(
            self.run_stage(
                self.worker, self.runtime, "relative", self.notices
            ).returncode,
            2,
        )
        self.worker.chmod(0o644)
        self.assertEqual(
            self.run_stage(
                self.worker, self.runtime, self.staging, self.notices
            ).returncode,
            2,
        )


if __name__ == "__main__":
    unittest.main()
