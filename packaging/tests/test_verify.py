import os
import shutil
import subprocess
import tarfile
import unittest
from pathlib import Path

from roots import PACKAGING, SCRATCH

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
    "tts/libonnxruntime.so.1",
    "tts/notices/LICENSE",
    "tts/notices/licensing/runtime-third-party-programs.txt",
    "tts/notices/licensing/onetbb_third-party-programs.txt",
    "tts/notices/licensing/onednn_third-party-programs.txt",
    "tts/notices/INDIC-TINY-TTS-CODE-LICENSE",
    "tts/notices/onnxruntime/LICENSE",
    "tts/notices/onnxruntime/ThirdPartyNotices.txt",
)
INSTALL_DIR = "/usr/lib/Vaakora/"
LICENCE = "/usr/share/licenses/vaakora/LICENSE"
WEAK = {
    "rpm": ("intel-compute-runtime", "intel-level-zero", "oneapi-level-zero", "wl-clipboard"),
    "deb": ("intel-opencl-icd", "libze1", "libze-intel-gpu1", "wl-clipboard"),
}
PACKAGES = {
    "rpm": "Vaakora-1.0.0-1.x86_64.rpm",
    "deb": "Vaakora_1.0.0_amd64.deb",
    "arch": "vaakora-1.0.0-1-x86_64.pkg.tar.zst",
    "appimage": "Vaakora_1.0.0_amd64.AppImage",
}
# ELF stand-ins: the magic, then the tokens the stub readelf reports. GLIBCXX_ and GLIBC_PRIVATE are not glibc versions.
ELVES = {
    "usr/bin/vaakora": "libc.so.6 libwebkit2gtk-4.1.so.0 GLIBC_2.34 GLIBCXX_3.4.30 GLIBC_PRIVATE",
    "usr/lib/Vaakora/llm/llama-server": "libc.so.6 GLIBC_2.17",
    "usr/lib/Vaakora/tts/vaakora-tts": "libc.so.6 libonnxruntime.so.1 GLIBC_2.35",
}
# READELF_RC fails every call, or only the -d or -V calls when READELF_MODE names one.
READELF = r"""if [ "${READELF_RC:-0}" != 0 ] && [ "${READELF_MODE:-$1}" = "$1" ]; then exit "$READELF_RC"; fi
for file; do :; done
case "$1" in
  -d) tr ' ' '\n' <"$file" | grep '^lib.*\.so' | while read -r token; do
        echo " 0x0000000000000001 (NEEDED)             Shared library: [$token]"
      done ;;
  -V) tr ' ' '\n' <"$file" | grep '^GLIBC' | while read -r token; do
        echo "  0x0010:   Name: $token  Flags: none  Version: 2"
      done ;;
  *) exit 64 ;;
esac
"""
RPM = r"""if [ "${RPM_RC:-0}" != 0 ]; then exit "$RPM_RC"; fi
case "$*" in "-qp --recommends "*) cat "$RPM_DEPS" ;; *) exit 64 ;; esac
"""
RPM2CPIO = 'cd "$PAYLOAD"\nfind . | cpio -o -H newc --quiet\n'
WORK = PACKAGING / ".work"


class VerifyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scratch = SCRATCH / "verify-fixture"
        shutil.rmtree(self.scratch, ignore_errors=True)
        self.scratch.mkdir(parents=True)
        self.bin = self.scratch / "bin"
        self.bin.mkdir()
        for name, code in (("readelf", READELF), ("rpm", RPM), ("rpm2cpio", RPM2CPIO)):
            path = self.bin / name
            path.write_text("#!/bin/sh\nset -eu\n" + code)
            path.chmod(0o755)
        self.environment = {**os.environ, "PATH": str(self.bin) + ":" + os.environ["PATH"]}

    def tearDown(self) -> None:
        shutil.rmtree(self.scratch)

    def tree(self, kind: str, drop: tuple[str, ...] = (), extra: dict[str, str] | None = None) -> Path:
        """The fixture payload: every required file, the licence, the ELF stand-ins and a text file naming libssl."""
        root = self.scratch / kind / "tree"
        shutil.rmtree(root, ignore_errors=True)
        files = {INSTALL_DIR + name: "fixture" for name in REQUIRED}
        files[LICENCE] = "licence"
        files["/usr/lib/Vaakora/notes.txt"] = "libssl.so.3\n"
        for path, tokens in ELVES.items():
            files["/" + path] = "\x7fELF " + tokens
        files.update(extra or {})
        for path in drop:
            del files[path]
        for path, content in files.items():
            target = root / path.lstrip("/")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content.encode("latin-1"))
        return root

    def pack(self, kind: str, root: Path, weak: tuple[str, ...] | None = None) -> tuple[Path, dict[str, str]]:
        """Pack the payload as the given kind; returns the package and the environment the stubs read."""
        work = self.scratch / kind
        package = work / PACKAGES[kind]
        package.unlink(missing_ok=True)
        environment: dict[str, str] = {}
        weak = WEAK.get(kind, ()) if weak is None else weak
        if kind == "rpm":
            package.touch()
            deps = work / "rpm-deps"
            deps.write_text("".join(name + "\n" for name in weak))
            environment = {"PAYLOAD": str(root), "RPM_DEPS": str(deps)}
        elif kind == "deb":
            members = work / "members"
            shutil.rmtree(members, ignore_errors=True)
            members.mkdir()
            (members / "debian-binary").write_text("2.0\n")
            control = work / "control"
            control.write_text(
                "Package: vaakora\nVersion: 1.0.0\nDepends: libgtk-3-0, libasound2t64 | libasound2\n"
                + "Recommends: " + ", ".join(weak) + "\nDescription: fixture\n"
            )
            with tarfile.open(members / "control.tar.gz", "w:gz") as archive:
                archive.add(control, arcname="control")
            with tarfile.open(members / "data.tar.gz", "w:gz") as archive:
                for child in sorted(root.iterdir()):
                    archive.add(child, arcname=child.name)
            subprocess.run(
                ["ar", "rc", str(package), "debian-binary", "control.tar.gz", "data.tar.gz"],
                cwd=members,
                check=True,
            )
        elif kind == "arch":
            subprocess.run(["tar", "--zstd", "-cf", str(package), "-C", str(root), "."], check=True)
        else:
            package.write_text(
                '#!/bin/sh\nset -eu\n[ "$*" = --appimage-extract ] || exit 64\n'
                + f"cp -R '{root}' ./squashfs-root\necho squashfs-root/AppRun\n"
            )
            package.chmod(0o755)
        return package, environment

    def verify(self, package: Path, environment: dict[str, str], **extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            # Run as documented, without a bash prefix, so a non-executable script fails.
            [str(PACKAGING / "verify-package.sh"), str(package)],
            capture_output=True,
            text=True,
            env={**self.environment, **environment, **extra},
        )

    def run_kind(
        self, kind: str, drop: tuple[str, ...] = (), extra: dict[str, str] | None = None, **stubs: str
    ) -> subprocess.CompletedProcess[str]:
        package, environment = self.pack(kind, self.tree(kind, drop, extra))
        return self.verify(package, environment, **stubs)

    def assertRefused(self, result: subprocess.CompletedProcess[str], line: str) -> None:
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("refusing: " + line, result.stderr.splitlines())
        self.assertNotIn("verified", result.stdout)

    def assertNoWorkDirLeft(self) -> None:
        self.assertEqual(sorted(WORK.glob("verify.*")), [])

    def test_complete_package_passes(self) -> None:
        for kind in PACKAGES:
            with self.subTest(kind=kind):
                package, environment = self.pack(kind, self.tree(kind))
                result = self.verify(package, environment)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, f"verified {kind}: {package}\n")
                self.assertEqual(result.stderr, "")
                self.assertNoWorkDirLeft()

    def test_each_required_file_is_required(self) -> None:
        for kind in PACKAGES:
            for path in [INSTALL_DIR + name for name in REQUIRED] + [LICENCE]:
                with self.subTest(kind=kind, path=path):
                    self.assertRefused(self.run_kind(kind, drop=(path,)), "missing " + path)

    def test_every_failure_is_reported(self) -> None:
        missing = INSTALL_DIR + "tts/libonnxruntime.so.1"
        for kind in PACKAGES:
            with self.subTest(kind=kind):
                result = self.run_kind(kind, drop=(missing,), extra={"/usr/bin/vaakora": "\x7fELF libc.so.6 GLIBC_2.36"})
                self.assertRefused(result, "missing " + missing)
                self.assertRefused(result, "/usr/bin/vaakora needs GLIBC_2.36, above GLIBC_2.35")
                self.assertEqual(len(result.stderr.splitlines()), 2, result.stderr)
                self.assertNoWorkDirLeft()

    def test_npu_driver_is_refused(self) -> None:
        for kind in PACKAGES:
            with self.subTest(kind=kind):
                result = self.run_kind(kind, extra={"/usr/lib/Vaakora/tts/libze_intel_npu.so.1": "driver"})
                self.assertRefused(result, kind + " bundles an NPU driver")

    def test_app_elf_linking_openssl_is_refused(self) -> None:
        worker = "/usr/lib/Vaakora/tts/vaakora-tts"
        for kind in PACKAGES:
            for needed in ("libssl.so.3", "libcrypto.so.3"):
                with self.subTest(kind=kind, needed=needed):
                    result = self.run_kind(kind, extra={worker: "\x7fELF libc.so.6 " + needed})
                    self.assertRefused(result, worker + " links libssl or libcrypto")
            with self.subTest(kind=kind, needed="libssl3-unrelated.so"):
                result = self.run_kind(kind, extra={worker: "\x7fELF libssl3-unrelated.so"})
                self.assertEqual(result.returncode, 0, result.stderr)
        for path in ("/usr/lib/libtranscribe.so.0", "/usr/lib/libggml-base.so.0", "/usr/bin/vaakora"):
            with self.subTest(kind="appimage", path=path):
                result = self.run_kind("appimage", extra={path: "\x7fELF libssl.so.3"})
                self.assertRefused(result, path + " links libssl or libcrypto")

    def test_bundled_appimage_library_may_link_openssl(self) -> None:
        result = self.run_kind("appimage", extra={"/usr/lib/libshout.so.3": "\x7fELF libc.so.6 libssl.so.3 GLIBC_2.17"})
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_glibc_above_2_35_is_refused(self) -> None:
        for kind in PACKAGES:
            with self.subTest(kind=kind, version="2.36"):
                result = self.run_kind(kind, extra={"/usr/bin/vaakora": "\x7fELF libc.so.6 GLIBC_2.2.5 GLIBC_2.36"})
                self.assertRefused(result, "/usr/bin/vaakora needs GLIBC_2.36, above GLIBC_2.35")
            with self.subTest(kind=kind, version="2.4 and 2.36"):
                result = self.run_kind(kind, extra={"/usr/bin/vaakora": "\x7fELF libc.so.6 GLIBC_2.4 GLIBC_2.36"})
                self.assertRefused(result, "/usr/bin/vaakora needs GLIBC_2.36, above GLIBC_2.35")
            for version in ("2.35", "2.4", "2.2.5"):
                with self.subTest(kind=kind, version=version):
                    result = self.run_kind(kind, extra={"/usr/bin/vaakora": "\x7fELF libc.so.6 GLIBC_" + version})
                    self.assertEqual(result.returncode, 0, result.stderr)
        with self.subTest(kind="appimage", path="bundled library"):
            result = self.run_kind("appimage", extra={"/usr/lib/libshout.so.3": "\x7fELF libc.so.6 GLIBC_2.36"})
            self.assertRefused(result, "/usr/lib/libshout.so.3 needs GLIBC_2.36, above GLIBC_2.35")

    def test_weak_dependencies(self) -> None:
        for kind, names in WEAK.items():
            for name in names:
                with self.subTest(kind=kind, dependency=name):
                    kept = tuple(other for other in names if other != name)
                    package, environment = self.pack(kind, self.tree(kind), kept)
                    self.assertRefused(self.verify(package, environment), "missing weak dependency " + name)

    def test_bad_arguments(self) -> None:
        package, environment = self.pack("rpm", self.tree("rpm"))
        other = self.scratch / "Vaakora.tar.gz"
        other.write_text("not a package")
        cases = {
            "relative": [os.path.relpath(package)],
            "unknown suffix": [str(other)],
            "missing": [str(self.scratch / "absent.rpm")],
            "none": [],
            "two": [str(package), str(package)],
        }
        for case, arguments in cases.items():
            with self.subTest(case=case):
                result = subprocess.run(
                    [str(PACKAGING / "verify-package.sh"), *arguments],
                    capture_output=True,
                    text=True,
                    env={**self.environment, **environment},
                )
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("usage: verify-package.sh ABSOLUTE_FILE", result.stderr)

    def test_tool_failure_fails_closed(self) -> None:
        for kind in PACKAGES:
            for mode in ("-d", "-V"):
                with self.subTest(kind=kind, tool="readelf " + mode):
                    result = self.run_kind(kind, READELF_RC="23", READELF_MODE=mode)
                    self.assertEqual(result.returncode, 23, result.stderr)
                    self.assertNoWorkDirLeft()
        with self.subTest(kind="rpm", tool="rpm"):
            self.assertEqual(self.run_kind("rpm", RPM_RC="17").returncode, 17)
        for kind in PACKAGES:
            with self.subTest(kind=kind, tool="unpack"):
                package = self.scratch / kind / PACKAGES[kind]
                package.parent.mkdir(parents=True, exist_ok=True)
                package.write_text("corrupt")
                result = self.verify(package, {"PAYLOAD": str(self.scratch / "absent"), "RPM_DEPS": os.devnull})
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("verified", result.stdout)
                self.assertNoWorkDirLeft()

    def test_text_file_naming_libssl_is_not_an_elf(self) -> None:
        for kind in PACKAGES:
            with self.subTest(kind=kind):
                result = self.run_kind(kind)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("libssl", result.stderr)


if __name__ == "__main__":
    unittest.main()
