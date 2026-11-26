# Packaging

Builds the Linux RPM, `.deb` and AppImage from this repository inside rootless podman. Everything the build needs is here; nothing outside the repository is read.

## Requirements

- Fedora host with rootless `podman`, `git`, `jq`, `curl`, `python3`, `rpm` and `sha256sum`. The host needs no `-devel` packages.
- Network access on the first run (Ubuntu 22.04 base image, the pinned toolchain downloads, crates, bun packages, the pinned llama.cpp tag and the pinned OpenVINO wheel).

## Build

```bash
packaging/build.sh [--stage-only] [--cpu x86-64-v3|native]
```

- Refuses a dirty tree: the build archives `HEAD` into `packaging/.work/src` (the commit is recorded in `packaging/.work/src/.vaakora-sha`). Commit first.
- The version comes from `src-tauri/tauri.conf.json` at `HEAD`.
- Builds the release image `vaakora-build:jammy` (Ubuntu 22.04, glibc 2.35) from `packaging/Containerfile.jammy` and uses the volumes `vaakora-jammy-cargo`, `vaakora-jammy-bun`, `vaakora-jammy-target` and `vaakora-jammy-ortcache`, apart from the Fedora image and volumes `dev.sh` uses. The first build is cold: expect a long compile.
- `--cpu x86-64-v3` (default) builds `llama-server` for any CPU with AVX2, FMA and F16C. `--cpu native` tunes it to the build machine and may crash with an illegal instruction on other CPUs.
- The RPM, the `.deb` and the AppImage land in `packaging/dist/`; `packaging/verify-rpm.sh` checks the RPM's contents.

## Pins

| Input            | Pin                                                                                                                                                                      | Script                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| llama.cpp        | tag `b11260`, commit `e904318a2d3e2382e78c98b4353c5dd569c079f6` (refused on a mismatch)                                                                                  | `llama-server.sh`     |
| OpenVINO runtime | wheel `openvino-2026.4.1-22982-cp313-cp313-manylinux_2_28_x86_64.whl`, sha256 `a9b637846c579d7b81b17b6585e0c7b1947574e8d13cf83d7307ce50cd2c352e` (refused on a mismatch) | `openvino-runtime.sh` |

`packaging/llama-server.sh <out-dir> [--cpu ...]` and `packaging/openvino-runtime.sh <dest-dir> [--wheel <file>]` can be run on their own. The OpenVINO wheel and the built binaries are cached under `packaging/.work/`; the llama.cpp git clone lives outside the checkout, in `${XDG_CACHE_HOME:-$HOME/.cache}/vaakora-build/llama.cpp-<commit>`, so the checkout never holds a nested `.git`. The clone and the build directory (`packaging/.work/llama-build-jammy-<commit>-<cpu>`) are keyed by the pinned commit, so moving the pin starts from fresh sources and never trips over what the old pin left behind.

## Install

```bash
packaging/install.sh [--dry-run]
```

Picks the newest RPM in `packaging/dist/` whose name and version match this checkout and runs `sudo dnf` install, upgrade, downgrade or reinstall with `--nogpgcheck` (the local RPM is unsigned).

The package is named `vaakora` and installs `/usr/bin/vaakora` and `/usr/lib/Vaakora/` (with `llm/llama-server` and `tts/vaakora-tts`) plus `/usr/share/licenses/vaakora/LICENSE`.

### Next to Handy

`vaakora` installs alongside `handy`: the two packages own no common path (`/usr/bin/vaakora` and `/usr/lib/Vaakora/` against `/usr/bin/handy` and `/usr/lib/Handy/`), and `dnf` accepts both. They are still two apps with one shortcut. If only one should answer the dictation and read-aloud shortcuts, quit Handy from its tray and turn off its "Start at login" before the first Vaakora start. Vaakora copies Handy's settings and data on that first start and leaves the Handy folder untouched; the copy has Vaakora's own "Start at login" off, and you turn it on in the app.

## Dev loop

```bash
packaging/dev.sh [--mount <host-path>:<container-path>]... [--env NAME=VALUE]... [--device /dev/dri/renderD128] [--device /dev/accel/accel0] <checkout> <command> [args...]
```

Runs one command (cargo, bun, ...) in `/src` inside the build image, with its own caches. Mounts are read-only and devices are opt-in. The dev image `vaakora-build:fedora45` (Fedora, from `packaging/Containerfile`) is separate from the release image `vaakora-build:jammy` that `build.sh` builds, and `build.sh` does not create it. It must already exist; build it once from the repository root with an empty context:

```bash
mkdir -p packaging/.work/dev-image-context \
  && podman build -f packaging/Containerfile -t vaakora-build:fedora45 packaging/.work/dev-image-context
```

## Brand check of the RPM

```bash
mise exec -- bun scripts/check-brand.ts --dist --rpm <absolute path of the RPM>
```

Prints `BRAND PASS` or one line per problem. The `rpm` section reads the package with `rpm`, `rpm2cpio`, `cpio` and `strings` (a tool that is missing or exits non-zero is a reported problem, never a pass; so it runs on the host, not in the build image, and the overlap check needs the `handy` package installed): the header (name, summary, URL, vendor, licence, description) names neither Handy nor its author; every path is `/usr/bin/vaakora`, under `/usr/lib/Vaakora/`, `/usr/share/applications/Vaakora.desktop`, a `vaakora.png` icon or `/usr/share/licenses/vaakora/LICENSE`; the desktop entry has `Name=Vaakora`, `Exec=vaakora`, `Icon=vaakora` and no Handy; the licence equals the repository `LICENSE`; no path is also owned by the installed `handy` package; and the `vaakora` binary holds no "handy" string except the internal identifiers listed in `STRINGS_ALLOW` in `scripts/brand-rpm.ts`. Its unit tests are `bun test ./scripts/brand-rpm.test.ts`.

## Tests

```bash
python3 -I -m unittest discover -s packaging/tests -t packaging/tests
```

Fixtures live under `packaging/.work/test-scratch` (override with `VAAKORA_TEST_SCRATCH`, which must stay inside the repository).
