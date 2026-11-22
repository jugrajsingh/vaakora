import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import unittest
import zipfile

from roots import PACKAGING, SCRATCH

LLAMA_COMMIT = "e904318a2d3e2382e78c98b4353c5dd569c079f6"
OTHER_TAG = "b99999"
OTHER_COMMIT = "0123456789abcdef0123456789abcdef01234567"
WHEEL_SHA256 = "a9b637846c579d7b81b17b6585e0c7b1947574e8d13cf83d7307ce50cd2c352e"
LIBRARIES = (
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
NOTICES = (
    "LICENSE",
    "licensing/runtime-third-party-programs.txt",
    "licensing/onetbb_third-party-programs.txt",
    "licensing/onednn_third-party-programs.txt",
)


class OpenVinoPinTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scratch = SCRATCH / "pins-openvino"
        shutil.rmtree(self.scratch, ignore_errors=True)
        self.scratch.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.wheel = self.scratch / "fixture.whl"
        with zipfile.ZipFile(self.wheel, "w") as archive:
            for name in LIBRARIES:
                archive.writestr("openvino/libs/" + name, b"fixture library")
            for name in NOTICES:
                archive.writestr("openvino-2026.4.1.dist-info/licenses/" + name, "fixture notice")
        self.dest = self.scratch / "dest"

    def run_script(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(PACKAGING / "openvino-runtime.sh"), *arguments],
            capture_output=True,
            text=True,
            timeout=60,
        )

    def test_openvino_wrong_hash_is_refused(self) -> None:
        result = self.run_script(str(self.dest), "--wheel", str(self.wheel))
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(WHEEL_SHA256, result.stderr)
        self.assertFalse(self.dest.exists())


class LlamaPinTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scratch = SCRATCH / "pins-llama"
        shutil.rmtree(self.scratch, ignore_errors=True)
        self.scratch.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.packaging = self.scratch / "packaging"
        self.packaging.mkdir()
        shutil.copyfile(PACKAGING / "llama-server.sh", self.packaging / "llama-server.sh")
        self.bin = self.scratch / "bin"
        self.bin.mkdir()
        self.trace = self.scratch / "trace"
        self.cmake_trace = self.scratch / "cmake-trace"
        self.out = self.scratch / "out"
        self.cache = self.scratch / "cache"
        self.clone = self.cache / f"vaakora-build/llama.cpp-{LLAMA_COMMIT}"
        self.env = {
            **os.environ,
            "PATH": str(self.bin) + ":" + os.environ["PATH"],
            "PODMAN_TRACE": str(self.trace),
            "CMAKE_TRACE": str(self.cmake_trace),
            "XDG_CACHE_HOME": str(self.cache),
        }
        self.tool("cmake", 'echo "$*" >>"$CMAKE_TRACE"\n')
        self.tool("install", 'case "$*" in */work/llama-build/*) exit 0;; *) exec /usr/bin/install "$@";; esac\n')
        podman = self.bin / "podman"
        podman.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, subprocess, sys\n"
            "from pathlib import Path\n"
            "args = sys.argv[1:]\n"
            'with Path(os.environ["PODMAN_TRACE"]).open("a") as stream:\n'
            '    stream.write(json.dumps(args) + "\\n")\n'
            'mounts = {a.split(":")[1]: a.split(":")[0] for a in (args[i + 1] for i, v in enumerate(args) if v == "-v")}\n'
            'result = subprocess.run(["bash", "-c", args[-1]])\n'
            "if result.returncode == 0:\n"
            '    target = Path(mounts["/out"]) / "llama-server"\n'
            '    target.write_text("#!/bin/sh\\n")\n'
            "    target.chmod(0o755)\n"
            "sys.exit(result.returncode)\n"
        )
        podman.chmod(0o755)

    def tool(self, name: str, code: str) -> None:
        path = self.bin / name
        path.write_text("#!/bin/sh\nset -eu\n" + code)
        path.chmod(0o755)

    def pin_head(self) -> None:
        (self.clone / ".git").mkdir(parents=True)
        self.tool("git", 'case "$*" in *"rev-parse HEAD") echo ' + LLAMA_COMMIT + ';; *) echo "unexpected git call $*" >&2; exit 23;; esac\n')

    def run_script(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(self.packaging / "llama-server.sh"), str(self.out), *arguments],
            capture_output=True,
            text=True,
            env=self.env,
            timeout=60,
        )

    def test_llama_commit_mismatch_is_refused(self) -> None:
        clone = self.clone
        clone.mkdir(parents=True)
        git = ("git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", str(clone))
        subprocess.run(["git", "-C", str(clone), "init", "-q", "-b", "main"], check=True)
        subprocess.run([*git, "commit", "-q", "--allow-empty", "-m", "other"], check=True)
        result = self.run_script()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(LLAMA_COMMIT, result.stderr)
        self.assertFalse(self.trace.exists())
        self.assertFalse(self.cmake_trace.exists())
        self.assertFalse(self.out.exists())

    def other_pin_script(self) -> Path:
        """A copy of the script pinned to a different tag and commit, in its own packaging dir."""
        directory = self.scratch / "packaging-other"
        directory.mkdir()
        text = (PACKAGING / "llama-server.sh").read_text()
        text, tag_count = re.subn(r"^LLAMA_TAG=.*$", f"LLAMA_TAG={OTHER_TAG}", text, flags=re.M)
        text, commit_count = re.subn(r"^LLAMA_COMMIT=.*$", f"LLAMA_COMMIT={OTHER_COMMIT}", text, flags=re.M)
        self.assertEqual((tag_count, commit_count), (1, 1))
        script = directory / "llama-server.sh"
        script.write_text(text)
        return script

    def test_a_cache_of_another_pin_never_blocks_a_new_pin(self) -> None:
        # The old pin's cache, under both its commit-keyed name and the old unkeyed name.
        for name in (f"llama.cpp-{LLAMA_COMMIT}", "llama.cpp"):
            old = self.cache / "vaakora-build" / name
            (old / ".git").mkdir(parents=True)
            (old / ".fake-commit").write_text(LLAMA_COMMIT + "\n")
        self.tool(
            "git",
            'dir=.; prev=; for a; do [ "$prev" = -C ] && dir=$a; prev=$a; done\n'
            'case "$*" in\n'
            '*"rev-parse HEAD") cat "$dir/.fake-commit";;\n'
            'clone*) echo "$*" >"$CLONE_TRACE"; for last; do :; done; mkdir -p "$last/.git"; echo ' + OTHER_COMMIT + ' >"$last/.fake-commit";;\n'
            '*) echo "unexpected git call $*" >&2; exit 23;;\n'
            'esac\n',
        )
        self.env["CLONE_TRACE"] = str(self.scratch / "clone-trace")
        script = self.other_pin_script()
        result = subprocess.run(["bash", str(script), str(self.out)], capture_output=True, text=True, env=self.env, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        fresh = self.cache / f"vaakora-build/llama.cpp-{OTHER_COMMIT}"
        clone = (self.scratch / "clone-trace").read_text()
        self.assertIn(f"--branch {OTHER_TAG} ", clone)
        self.assertTrue(clone.strip().endswith(str(fresh)), clone)
        for name in (f"llama.cpp-{LLAMA_COMMIT}", "llama.cpp"):
            self.assertEqual((self.cache / "vaakora-build" / name / ".fake-commit").read_text().strip(), LLAMA_COMMIT)
        self.assertTrue((script.parent / f".work/llm-bin-{OTHER_COMMIT}-x86-64-v3/llama-server").is_file())
        self.assertIn(f"llama-server {OTHER_TAG} ({OTHER_COMMIT}", result.stdout)
        self.assertTrue(self.out.joinpath("llama-server").is_file())

    def test_each_pin_builds_in_its_own_directory(self) -> None:
        self.pin_head()
        self.assertEqual(self.run_script().returncode, 0)
        self.assertTrue(any(f"llama-build-{LLAMA_COMMIT}-x86-64-v3" in line for line in self.trace.read_text().splitlines()))

    def test_llama_cpu_flags(self) -> None:
        self.pin_head()
        result = self.run_script("--cpu", "x86-64-v3")
        self.assertEqual(result.returncode, 0, result.stderr)
        flags = self.cmake_trace.read_text()
        self.assertIn("-DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON", flags)
        self.assertNotIn("-DGGML_NATIVE=ON", flags)
        self.assertTrue((self.packaging / f".work/llm-bin-{LLAMA_COMMIT}-x86-64-v3/llama-server").is_file())
        self.assertTrue((self.out / "llama-server").is_file())
        self.cmake_trace.unlink()
        result = self.run_script("--cpu", "native")
        self.assertEqual(result.returncode, 0, result.stderr)
        flags = self.cmake_trace.read_text()
        self.assertIn("-DGGML_NATIVE=ON", flags)
        self.assertNotIn("-DGGML_NATIVE=OFF", flags)
        self.assertNotIn("-DGGML_AVX", flags)
        self.assertTrue((self.packaging / f".work/llm-bin-{LLAMA_COMMIT}-native/llama-server").is_file())

    def test_default_cpu_target_is_x86_64_v3_and_is_cached(self) -> None:
        self.pin_head()
        self.assertEqual(self.run_script().returncode, 0)
        self.assertIn("-DGGML_NATIVE=OFF", self.cmake_trace.read_text())
        runs = len(self.trace.read_text().splitlines())
        self.assertEqual(self.run_script().returncode, 0)
        self.assertEqual(len(self.trace.read_text().splitlines()), runs)

    def test_clone_goes_to_the_cache_outside_the_checkout(self) -> None:
        self.tool(
            "git",
            'case "$*" in\n'
            '*"rev-parse HEAD") echo ' + LLAMA_COMMIT + ';;\n'
            'clone*) for last; do :; done; echo "$last" >"$CLONE_TRACE"; mkdir -p "$last/.git";;\n'
            '*) echo "unexpected git call $*" >&2; exit 23;;\n'
            'esac\n',
        )
        self.env["CLONE_TRACE"] = str(self.scratch / "clone-trace")
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.scratch / "clone-trace").read_text().strip(), str(self.clone))
        self.assertEqual(list(self.packaging.rglob(".git")), [])
        self.assertTrue(self.clone.is_relative_to(self.cache))

    def test_unknown_cpu_target_exits_2_before_any_build(self) -> None:
        self.pin_head()
        result = self.run_script("--cpu", "znver9")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(self.trace.exists())
        self.assertFalse(self.out.exists())


if __name__ == "__main__":
    unittest.main()
