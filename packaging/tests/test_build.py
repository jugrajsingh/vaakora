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
BUNDLES = {
    "rpm": "Vaakora-1.0.0-1.x86_64.rpm",
    "deb": "Vaakora_1.0.0_amd64.deb",
    "appimage": "Vaakora_1.0.0_amd64.AppImage",
}
TAURI_CALL = 'bun run tauri build --bundles deb,rpm,appimage --config {"bundle":{"createUpdaterArtifacts":false}}'
WORKER_LINK = "rustc --locked --release --package handy-tts --bin vaakora-tts -- -C link-arg=-Wl,-rpath,$ORIGIN"
FAKE_BUN = r"""echo "bun $*" >>"$TRACE"
case "$*" in "run tauri"*)
  cmp -s "$HOME/.cache/tauri/linuxdeploy-x86_64.AppImage" "$TOOLS_FIXTURE" || exit 9
  if [ "${TAURI_RC:-0}" != 0 ]; then exit "$TAURI_RC"; fi
  requested=",$(echo "$*" | sed -n 's/.*--bundles \([^ ]*\).*/\1/p'),"
  for kind in rpm deb appimage; do
    case "$requested" in *",$kind,"*) ;; *) continue ;; esac
    if [ "${SKIP_BUNDLE:-}" = "$kind" ]; then continue; fi
    case "$kind" in
      rpm) name=Vaakora-1.0.0-1.x86_64.rpm ;;
      deb) name=Vaakora_1.0.0_amd64.deb ;;
      appimage) name=Vaakora_1.0.0_amd64.AppImage ;;
    esac
    mkdir -p "$CARGO_TARGET_DIR/release/bundle/$kind"
    echo "$kind" >"$CARGO_TARGET_DIR/release/bundle/$kind/$name"
  done
  ;;
esac
"""
WORKING_STAGER = 'set -eu\necho stage >>"$TRACE"\nmkdir -p "$3/usr/lib/Vaakora/tts"\ncp "$1" "$3/usr/lib/Vaakora/tts/vaakora-tts"\n'
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
        self.ort = self.scratch / "ort"
        (self.ort / "lib").mkdir(parents=True)
        (self.ort / "lib/libonnxruntime.so.1").write_text("ort")
        (self.ort / "notices").mkdir()
        (self.ort / "notices/LICENSE").write_text("ort licence")
        (self.ort / "notices/ThirdPartyNotices.txt").write_text("ort third-party notices")
        self.tools = self.scratch / "tools"
        self.tools.mkdir()
        (self.tools / "linuxdeploy-x86_64.AppImage").write_text("pinned linuxdeploy")
        self.cargo_args = self.scratch / "cargo-args"
        self.environment = {
            **os.environ,
            "PATH": str(self.bin) + ":" + os.environ["PATH"],
            "HOME": str(self.scratch),
            "CARGO_TARGET_DIR": str(self.target),
            "HANDY_VERSION": "1.0.0",
            "ORT_LIB_PATH": str(self.ort / "lib"),
            "TAURI_TOOLS": str(self.tools),
            "TOOLS_FIXTURE": str(self.tools / "linuxdeploy-x86_64.AppImage"),
            "TRACE": str(self.trace),
            "CARGO_ARGS": str(self.cargo_args),
        }
        self.script(
            "cargo",
            'echo cargo >>"$TRACE"\necho "$*" >>"$CARGO_ARGS"\nif [ "${CARGO_RC:-0}" != 0 ]; then exit "$CARGO_RC"; fi\nif [ "${NO_WORKER:-0}" = 0 ]; then mkdir -p "$CARGO_TARGET_DIR/release"; printf "#!/bin/sh\\nexit 0\\n" >"$CARGO_TARGET_DIR/release/vaakora-tts"; chmod +x "$CARGO_TARGET_DIR/release/vaakora-tts"; fi\n',
        )
        self.script("bun", FAKE_BUN)
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

    def build(self, drop: tuple[str, ...] = (), **environment: str) -> subprocess.CompletedProcess[str]:
        merged = {**self.environment, **environment}
        for name in drop:
            del merged[name]
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
            env=merged,
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
        self.stager.write_text(WORKING_STAGER)
        result = self.build(TAURI_RC="23")
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertEqual(list(self.output.iterdir()), [])
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.output / BUNDLES["rpm"]).is_file())
        self.script("bun", 'echo "bun $*" >>"$TRACE"\n')
        self.assertEqual(self.build().returncode, 1)

    def test_tauri_builds_deb_rpm_and_appimage(self) -> None:
        self.stager.write_text(WORKING_STAGER)
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(TAURI_CALL, self.trace.read_text().splitlines())
        self.assertEqual(sorted(path.name for path in self.output.iterdir()), sorted(BUNDLES.values()))

    def test_each_missing_bundle_fails(self) -> None:
        self.stager.write_text(WORKING_STAGER)
        for kind, name in BUNDLES.items():
            with self.subTest(bundle=kind):
                result = self.build(SKIP_BUNDLE=kind)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("refusing: tauri wrote no " + name, result.stderr)
                self.assertEqual(list(self.output.iterdir()), [])

    def test_worker_links_with_origin_runpath(self) -> None:
        self.stager.write_text(WORKING_STAGER)
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.cargo_args.read_text().splitlines(), [WORKER_LINK])

    def test_onnxruntime_and_notices_are_staged(self) -> None:
        self.stager.write_text(WORKING_STAGER)
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        staged = self.source / "src-tauri/tts-bin"
        self.assertEqual((staged / "libonnxruntime.so.1").read_text(), "ort")
        for notice in ("LICENSE", "ThirdPartyNotices.txt"):
            with self.subTest(notice=notice):
                self.assertEqual(
                    (staged / "notices/onnxruntime" / notice).read_text(),
                    (self.ort / "notices" / notice).read_text(),
                )

    def test_pinned_tauri_tools_are_installed_before_tauri(self) -> None:
        self.stager.write_text(WORKING_STAGER)
        cached = self.scratch / ".cache/tauri/linuxdeploy-x86_64.AppImage"
        cached.parent.mkdir(parents=True)
        cached.write_text("unpinned download")
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(cached.read_text(), "pinned linuxdeploy")
        self.assertTrue(os.access(cached, os.X_OK))

    def test_missing_env_is_a_usage_error(self) -> None:
        for name in ("ORT_LIB_PATH", "TAURI_TOOLS"):
            with self.subTest(missing=name):
                result = self.build(drop=(name,))
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("usage: build-tts-inner.sh", result.stderr)
                self.assertFalse(self.trace.exists())

    def test_indic_code_notice_is_staged_with_both_copyrights_and_permission_text(
        self,
    ) -> None:
        self.stager.write_text(WORKING_STAGER)
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

    def test_linux_bundle_config(self) -> None:
        linux = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())["bundle"]["linux"]
        files = {
            "/usr/lib/Vaakora": "transcribe-libs",
            "/usr/lib/Vaakora/llm": "llm-bin",
            "/usr/lib/Vaakora/tts": "tts-bin",
            LICENCE: "../LICENSE",
        }
        self.assertEqual(
            linux["deb"],
            {
                "depends": [
                    "libgtk-layer-shell0",
                    "libopenblas0",
                    "libasound2t64 | libasound2",
                    "libvulkan1",
                    "ocl-icd-libopencl1 | libopencl1",
                ],
                "recommends": ["intel-opencl-icd", "libze1", "libze-intel-gpu1", "wl-clipboard"],
                "files": files,
            },
        )
        self.assertEqual(
            linux["rpm"],
            {
                "depends": [
                    "libgtk-layer-shell.so.0()(64bit)",
                    "libopenblas.so.0()(64bit)",
                    "libasound.so.2()(64bit)",
                    "libvulkan.so.1()(64bit)",
                    "libOpenCL.so.1()(64bit)",
                ],
                "compression": {"type": "none"},
                "files": files,
                "recommends": list(DEPS),
            },
        )
        self.assertEqual(
            linux["appimage"],
            {
                "bundleMediaFramework": True,
                "files": {
                    "/usr/lib": "transcribe-libs",
                    "/usr/lib/Vaakora/llm": "llm-bin",
                    "/usr/lib/Vaakora/tts": "tts-bin",
                    LICENCE: "../LICENSE",
                },
            },
        )


if __name__ == "__main__":
    unittest.main()
