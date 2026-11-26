from pathlib import Path
import re
import unittest

from roots import PACKAGING

CONTAINERFILES = [PACKAGING / "Containerfile.jammy", PACKAGING / "arch/Containerfile"]


def instructions(text: str) -> list[str]:
    """Dockerfile instructions with backslash continuations joined."""
    return [part.strip() for part in re.sub(r"\\\n\s*", " ", text).splitlines() if part.strip() and not part.lstrip().startswith("#")]


def expand(text: str, args: dict[str, str]) -> str:
    return re.sub(r"\$\{(\w+)\}|\$(\w+)", lambda m: args.get(m.group(1) or m.group(2), m.group(0)), text)


class ImagePinTests(unittest.TestCase):
    def test_base_image_is_pinned_by_digest(self) -> None:
        for path in CONTAINERFILES:
            froms = [line for line in instructions(path.read_text()) if line.startswith("FROM ")]
            self.assertTrue(froms, f"{path.name} has no FROM line")
            for line in froms:
                self.assertRegex(line, r"^FROM \S+@sha256:[0-9a-f]{64}$", f"{path.name}: base image not pinned by digest")

    def test_every_download_is_sha256_checked(self) -> None:
        for path in CONTAINERFILES:
            lines = instructions(path.read_text())
            args = {m.group(1): m.group(2) for line in lines if (m := re.match(r"ARG (\w+)=(\S+)$", line))}
            for line in lines:
                if not line.startswith("RUN "):
                    continue
                run = expand(line, args)
                downloaded = set()
                for m in re.finditer(r"\bcurl\b[^&|;]*?(?:\s-o\s+(\S+)|\s--output\s+(\S+))", run):
                    downloaded.add(self.resolve(m.group(1) or m.group(2), run))
                if not downloaded:
                    continue
                checked = {self.resolve(name, run) for name in re.findall(r"\b[0-9a-f]{64}  ([^\s'\"|\\]+)", run)}
                for name in sorted(downloaded - checked):
                    self.fail(f"{path.name}: {name} is downloaded but never named in a sha256sum -c input")
                self.assertIn("sha256sum -c -", run, f"{path.name}: downloads without sha256sum -c")

    @staticmethod
    def resolve(name: str, run: str) -> str:
        """Files fetched after `cd <dir>` are relative to it; make them comparable."""
        name = name.strip("'\"")
        cd = re.search(r"\bcd (\S+)", run)
        if cd and not name.startswith("/"):
            return f"{cd.group(1)}/{name}"
        return name

    def test_toolchain_pins(self) -> None:
        text = (PACKAGING / "Containerfile.jammy").read_text()
        for pin in ("RUST_VERSION=1.100.0", "BUN_VERSION=1.4.5", "VULKAN_SDK_VERSION=1.4.350.1", "ORT_VERSION=1.31.0"):
            self.assertRegex(text, rf"(?m)^ARG {re.escape(pin)}$")


if __name__ == "__main__":
    unittest.main()
