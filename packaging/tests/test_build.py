import json
import os
import shutil
import subprocess
import unittest

from roots import PACKAGING, ROOT, SCRATCH

REQUIRED = (
    "resources/tts/ratings.json",
    "llm/llama-server",
    "tts/vaakora-tts",
    "tts/libopenvino.so.2641",
    "tts/libopenvino_c.so.2641",
    "tts/libopenvino_onnx_frontend.so.2641",
    "tts/libopenvino_ir_frontend.so.2641",
    "tts/libopenvino_intel_cpu_plugin.so",
    "tts/libopenvino_intel_gpu_plugin.so",
    "tts/libopenvino_intel_npu_plugin.so",
    "tts/libtbb.so.12",
    "tts/libhwloc.so.15",
    "tts/notices/LICENSE",
    "tts/notices/licensing/runtime-third-party-programs.txt",
    "tts/notices/licensing/onetbb_third-party-programs.txt",
    "tts/notices/licensing/onednn_third-party-programs.txt",
    "tts/notices/INDIC-TINY-TTS-CODE-LICENSE",
)
INDIC_NOTICE = "crates/handy-tts/INDIC-TINY-TTS-CODE-LICENSE"
LICENCE = "/usr/share/licenses/vaakora/LICENSE"
DEPS = (
    "intel-compute-runtime",
    "intel-level-zero",
    "oneapi-level-zero",
    "wl-clipboard",
)
GIT = ("git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false")


class BuildTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scratch = SCRATCH / "build-fixture"
        shutil.rmtree(self.scratch, ignore_errors=True)
        self.scratch.mkdir(parents=True)
        self.bin = self.scratch / "bin"
        self.bin.mkdir()
        self.source = self.scratch / "source"
        (self.source / "src-tauri/tts-bin").mkdir(parents=True)
        (self.source / "crates/handy-tts").mkdir(parents=True)
        shutil.copyfile(ROOT / INDIC_NOTICE, self.source / INDIC_NOTICE)
        (self.source / "src-tauri/tts-bin/stale-driver").write_text("stale")
        self.target = self.scratch / "target"
        self.runtime = self.scratch / "runtime"
        self.runtime.mkdir()
        self.output = self.scratch / "output"
        self.output.mkdir()
        self.trace = self.scratch / "trace"
        self.stager = self.scratch / "stage.sh"
        self.stager.write_text(
            'set -eu\necho stage >>"$TRACE"\nexit "${STAGE_RC:-0}"\n'
        )
        self.environment = {
            **os.environ,
            "PATH": str(self.bin) + ":" + os.environ["PATH"],
            "CARGO_TARGET_DIR": str(self.target),
            "HANDY_VERSION": "1.0.0",
            "TRACE": str(self.trace),
        }
        self.script(
            "cargo",
            'echo cargo >>"$TRACE"\nif [ "${CARGO_RC:-0}" != 0 ]; then exit "$CARGO_RC"; fi\nif [ "${NO_WORKER:-0}" = 0 ]; then mkdir -p "$CARGO_TARGET_DIR/release"; printf "#!/bin/sh\\nexit 0\\n" >"$CARGO_TARGET_DIR/release/vaakora-tts"; chmod +x "$CARGO_TARGET_DIR/release/vaakora-tts"; fi\n',
        )
        self.script(
            "bun",
            'echo "bun $*" >>"$TRACE"\ncase "$*" in "run tauri"*) if [ "${TAURI_RC:-0}" != 0 ]; then exit "$TAURI_RC"; fi; mkdir -p "$CARGO_TARGET_DIR/release/bundle/rpm"; touch "$CARGO_TARGET_DIR/release/bundle/rpm/Vaakora-1.0.0-x86_64.rpm";; esac\n',
        )
        self.files = self.scratch / "files"
        self.files.write_text(
            "\n".join("/usr/lib/Vaakora/" + name for name in REQUIRED)
            + "\n"
            + LICENCE
            + "\n"
        )
        self.dependencies = self.scratch / "dependencies"
        self.dependencies.write_text("\n".join(DEPS) + "\n")
        self.package = self.scratch / "Vaakora.rpm"
        self.package.touch()
        self.payload = self.scratch / "payload"
        (self.payload / "usr/lib/Vaakora/tts").mkdir(parents=True)
        (self.payload / "usr/lib/Vaakora/tts/vaakora-tts").write_bytes(b"\x7fELF libc.so.6")
        (self.payload / "usr/lib/Vaakora/notes.txt").write_text("libssl.so.4\n")
        self.environment.update(
            {
                "RPM_FILES": str(self.files),
                "RPM_DEPS": str(self.dependencies),
                "PAYLOAD": str(self.payload),
                "TMPDIR": str(self.scratch),
            }
        )
        self.script(
            "rpm2cpio",
            'cd "$PAYLOAD"\nfind . | cpio -o -H newc --quiet\n',
        )
        self.script(
            "readelf",
            'if [ "${READELF_RC:-0}" != 0 ]; then exit "$READELF_RC"; fi\necho " 0x0000000000000001 (NEEDED)             Shared library: [$(sed "s/.* //" "$2")]"\n',
        )
        self.script(
            "rpm",
            'if [ "${RPM_RC:-0}" != 0 ]; then exit "$RPM_RC"; fi\ncase "$*" in -qlp*) cat "$RPM_FILES";; *) if [ "${DEPS_RC:-0}" != 0 ]; then exit "$DEPS_RC"; fi; cat "$RPM_DEPS";; esac\n',
        )

    def script(self, name: str, code: str) -> None:
        path = self.bin / name
        path.write_text("#!/bin/sh\nset -eu\n" + code)
        path.chmod(0o755)

    def tearDown(self) -> None:
        shutil.rmtree(self.scratch)

    def build(self, **environment: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "bash",
                str(PACKAGING / "build-tts-inner.sh"),
                str(self.source),
                str(self.runtime),
                str(self.stager),
                str(self.output),
                str(self.runtime),
            ],
            capture_output=True,
            text=True,
            env={**self.environment, **environment},
        )

    def verify(self, **environment: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(PACKAGING / "verify-rpm.sh"), str(self.package)],
            capture_output=True,
            text=True,
            env={**self.environment, **environment},
        )

    def fixture_repo(self) -> "os.PathLike[str]":
        repo = self.scratch / "repo"
        (repo / "packaging").mkdir(parents=True)
        (repo / "src-tauri").mkdir()
        for name in ("build.sh", "lib.sh"):
            shutil.copyfile(PACKAGING / name, repo / "packaging" / name)
        (repo / ".gitignore").write_text("/packaging/.work/\n/packaging/dist/\n")
        self.write_version(repo, "0.10.0")
        subprocess.run(["git", "-C", str(repo), "init", "-q", "-b", "main"], check=True)
        self.commit(repo, "fixture")
        return repo

    def write_version(self, repo, version: str) -> None:
        (repo / "src-tauri/tauri.conf.json").write_text(json.dumps({"version": version}))

    def commit(self, repo, message: str) -> str:
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        subprocess.run([*GIT, "-C", str(repo), "commit", "-q", "-m", message], check=True)
        return subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "HEAD"], check=True, capture_output=True, text=True
        ).stdout.strip()

    def stage(self, repo) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(repo / "packaging/build.sh"), "--stage-only"],
            capture_output=True,
            text=True,
            env=self.environment,
        )

    def test_stage_refuses_a_dirty_tree(self) -> None:
        repo = self.fixture_repo()
        for change in ("untracked", "modified"):
            with self.subTest(change=change):
                if change == "untracked":
                    (repo / "stray.txt").write_text("x")
                else:
                    (repo / "stray.txt").unlink()
                    self.write_version(repo, "9.9.9")
                result = self.stage(repo)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn("dirty", result.stderr)
                self.assertFalse((repo / "packaging/.work/src").exists())

    def test_stage_archives_head_and_reads_its_version(self) -> None:
        repo = self.fixture_repo()
        self.write_version(repo, "0.11.2")
        (repo / "tracked.txt").write_text("at head")
        head = self.commit(repo, "bump")
        (repo / "packaging/.work/ignored.txt").parent.mkdir(parents=True, exist_ok=True)
        (repo / "packaging/.work/ignored.txt").write_text("ignored")
        result = self.stage(repo)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("version 0.11.2", result.stdout)
        staged = repo / "packaging/.work/src"
        self.assertEqual((staged / ".vaakora-sha").read_text(), head + "\n")
        self.assertEqual((staged / "tracked.txt").read_text(), "at head")
        self.assertFalse((staged / "packaging/.work").exists())
        self.assertEqual(json.loads((staged / "src-tauri/tauri.conf.json").read_text())["version"], "0.11.2")

    def test_stage_refuses_an_unusable_cpu_target(self) -> None:
        repo = self.fixture_repo()
        result = subprocess.run(
            ["bash", str(repo / "packaging/build.sh"), "--stage-only", "--cpu", "znver9"],
            capture_output=True,
            text=True,
            env=self.environment,
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse((repo / "packaging/.work/src").exists())

    def test_cargo_failure_prevents_stager_and_tauri_and_removes_stale_staging(
        self,
    ) -> None:
        result = self.build(CARGO_RC="17")
        self.assertEqual(result.returncode, 17, result.stderr)
        self.assertEqual(self.trace.read_text().splitlines(), ["cargo"])
        self.assertFalse((self.source / "src-tauri/tts-bin").exists())

    def test_stager_failure_prevents_tauri(self) -> None:
        result = self.build(STAGE_RC="19")
        self.assertEqual(result.returncode, 19, result.stderr)
        self.assertEqual(self.trace.read_text().splitlines(), ["cargo", "stage"])

    def test_missing_worker_refuses_tauri(self) -> None:
        self.stager.write_text('set -eu\necho stage >>"$TRACE"\ntest -x "$1"\n')
        result = self.build(NO_WORKER="1")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertNotIn("bun", self.trace.read_text())

    def test_tauri_failure_and_no_rpm_are_not_swallowed(self) -> None:
        self.stager.write_text(
            'set -eu\necho stage >>"$TRACE"\nmkdir -p "$3/usr/lib/Vaakora/tts"\ncp "$1" "$3/usr/lib/Vaakora/tts/vaakora-tts"\n'
        )
        result = self.build(TAURI_RC="23")
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual(list(self.output.iterdir()), [])
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.output / "Vaakora-1.0.0-x86_64.rpm").is_file())
        self.script("bun", 'echo "bun $*" >>"$TRACE"\n')
        self.assertEqual(self.build().returncode, 1)

    def test_indic_code_notice_is_staged_with_both_copyrights_and_permission_text(
        self,
    ) -> None:
        self.stager.write_text(
            'set -eu\necho stage >>"$TRACE"\nmkdir -p "$3/usr/lib/Vaakora/tts"\ncp "$1" "$3/usr/lib/Vaakora/tts/vaakora-tts"\n'
        )
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        notice = self.source / "src-tauri/tts-bin/notices/INDIC-TINY-TTS-CODE-LICENSE"
        self.assertTrue(notice.is_file())
        staged = notice.read_text(encoding="utf-8")
        for notice in (
            "Copyright (c) 2026 Sulabh Katiyar",
            "Copyright (c) 2022 AI4Bhārat",
        ):
            self.assertIn(notice, staged)
        self.assertEqual(staged.count("Permission is hereby granted, free of charge"), 2)
        self.assertEqual(staged, (ROOT / INDIC_NOTICE).read_text(encoding="utf-8"))

    def test_rpm_query_failure_fails_closed(self) -> None:
        self.assertEqual(self.verify(RPM_RC="17").returncode, 17)
        self.assertEqual(self.verify(DEPS_RC="19").returncode, 19)

    def test_every_rpm_file_and_weak_dependency_is_required(self) -> None:
        complete_files = self.files.read_text()
        complete_deps = self.dependencies.read_text()
        self.assertEqual(self.verify().returncode, 0)
        for name in REQUIRED:
            with self.subTest(file=name):
                self.files.write_text(
                    complete_files.replace("/usr/lib/Vaakora/" + name + "\n", "")
                )
                self.assertEqual(self.verify().returncode, 1)
        self.files.write_text(complete_files)
        for name in DEPS:
            with self.subTest(dependency=name):
                self.dependencies.write_text(complete_deps.replace(name + "\n", ""))
                self.assertEqual(self.verify().returncode, 1)
        self.dependencies.write_text(complete_deps)
        self.files.write_text(
            complete_files + "/usr/lib/Vaakora/tts/libze_intel_npu.so.1\n"
        )
        self.assertEqual(self.verify().returncode, 1)

    def test_elf_linking_openssl_is_refused(self) -> None:
        binary = self.payload / "usr/lib/Vaakora/tts/vaakora-tts"
        self.assertEqual(self.verify().returncode, 0)
        for needed in ("libssl.so.4", "libcrypto.so.3"):
            with self.subTest(needed=needed):
                binary.write_bytes(b"\x7fELF " + needed.encode())
                result = self.verify()
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn(
                    "refusing: /usr/lib/Vaakora/tts/vaakora-tts links libssl or libcrypto",
                    result.stderr,
                )
        binary.write_bytes(b"\x7fELF libssl3-unrelated.so")
        self.assertEqual(self.verify().returncode, 0)

    def test_text_file_naming_libssl_is_not_an_elf(self) -> None:
        self.assertEqual(self.verify().returncode, 0)

    def test_unreadable_elf_fails_closed(self) -> None:
        self.assertEqual(self.verify(READELF_RC="23").returncode, 23)

    def test_package_without_ratings_is_refused(self) -> None:
        self.files.write_text(
            self.files.read_text().replace(
                "/usr/lib/Vaakora/resources/tts/ratings.json\n", ""
            )
        )
        result = self.verify()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(
            "missing /usr/lib/Vaakora/resources/tts/ratings.json", result.stderr
        )

    def test_licence_is_required(self) -> None:
        self.assertEqual(self.verify().returncode, 0)
        self.files.write_text(
            self.files.read_text().replace(LICENCE + "\n", "")
        )
        result = self.verify()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("missing " + LICENCE, result.stderr)

    def test_rpm_mapping_and_weak_dependencies(self) -> None:
        config = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())["bundle"][
            "linux"
        ]["rpm"]
        self.assertEqual(config["files"]["/usr/lib/Vaakora/tts"], "tts-bin")
        self.assertEqual(config["files"][LICENCE], "../LICENSE")
        self.assertEqual(config["recommends"], list(DEPS))


if __name__ == "__main__":
    unittest.main()
