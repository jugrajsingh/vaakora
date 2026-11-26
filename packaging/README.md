# Packaging

Builds Vaakora's Linux packages from this repository inside rootless podman. Everything the build needs is here; nothing outside the repository is read.

## What is built

One `packaging/build.sh` run writes four packages to `packaging/dist/`, where `<version>` is the version in `src-tauri/tauri.conf.json`:

| File                                     | Format   | Made by                                              |
| ---------------------------------------- | -------- | ---------------------------------------------------- |
| `Vaakora-<version>-1.x86_64.rpm`         | RPM      | tauri, in the release image                          |
| `Vaakora_<version>_amd64.deb`            | `.deb`   | tauri, in the release image                          |
| `vaakora-<version>-1-x86_64.pkg.tar.zst` | Arch     | `packaging/arch-package.sh`, from the `.deb` payload |
| `Vaakora_<version>_amd64.AppImage`       | AppImage | tauri, in the release image                          |

All four are built on Ubuntu 22.04 (glibc 2.35) and each one passes `packaging/verify-package.sh` before the build reports it.

## Requirements

- Fedora host with rootless `podman`, `git`, `jq`, `curl`, `python3`, `rpm`, `rpm2cpio`, `cpio`, `ar`, `tar` with zstd, `readelf`, `od` and `sha256sum`. The host needs no `-devel` packages: every compiler and library lives in the images.
- Network access on the first run (Ubuntu 22.04 and Arch Linux base images, the pinned toolchain downloads, crates, bun packages, the pinned llama.cpp tag, the pinned OpenVINO wheel and the pinned `fakeroot` package), and on every [install test](#install-test) run (target images and distribution packages).

## Images and volumes

| Image                    | Built from                      | Used by                                  | Volumes                                                                                      |
| ------------------------ | ------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `vaakora-build:jammy`    | `packaging/Containerfile.jammy` | `build.sh`, `llama-server.sh` (releases) | `vaakora-jammy-cargo`, `vaakora-jammy-bun`, `vaakora-jammy-target`, `vaakora-jammy-ortcache` |
| `vaakora-build:arch`     | `packaging/arch/Containerfile`  | `arch-package.sh`                        | none (builds in `packaging/.work/arch-build`)                                                |
| `vaakora-build:fedora45` | `packaging/Containerfile`       | `dev.sh` (the app's own tests and lints) | `vaakora-cargo`, `vaakora-bun`, `vaakora-target`, `vaakora-ortcache`                         |

The release image has its own volumes, apart from the Fedora image's: nothing built against Fedora's libraries is reused in a release. `build.sh` builds the release image and `arch-package.sh` builds the Arch image (a layer-cache hit after the first time); neither builds the Fedora image (see [Dev loop](#dev-loop)).

## Build

```bash
packaging/build.sh [--stage-only] [--cpu x86-64-v3|native]
```

- Refuses a dirty tree: the build archives `HEAD` into `packaging/.work/src` (the commit is recorded in `packaging/.work/src/.vaakora-sha`). Commit first.
- The version comes from `src-tauri/tauri.conf.json` at `HEAD`.
- `--stage-only` stops after the archive step.
- `--cpu x86-64-v3` (default) builds `llama-server` for any CPU with AVX2, FMA and F16C. `--cpu native` tunes it to the build machine and may crash with an illegal instruction on other CPUs.
- The first build is cold: expect a long compile.

In order, a full run:

1. builds the release image and `llama-server`, fetches the OpenVINO runtime, then in `vaakora-build:jammy` builds the TTS worker and runs tauri once to bundle the RPM, the `.deb` and the AppImage into `packaging/dist/`;
2. refuses (`refusing: tauri wrote no <name>`) when the `.deb` or the AppImage for this version is missing, and takes the newest RPM whose name and version match;
3. verifies the RPM and the `.deb`;
4. repacks the `.deb` as the Arch package (see [Arch package](#arch-package));
5. verifies the Arch package and the AppImage;
6. prints one `built: <path>` line per package, then the next steps: `next: packaging/install-test.sh packaging/dist <version>` and `next: packaging/install.sh` (as absolute paths).

Any failing step stops the run with a non-zero exit before a single `built:` line. The full log is in `packaging/.work/logs/build-<UTC stamp>.log`.

## Verifier

```bash
packaging/verify-package.sh <absolute path of a .rpm, .deb, .pkg.tar.zst or .AppImage>
```

Unpacks the package under `packaging/.work/` and refuses:

- a missing required file under `/usr/lib/Vaakora/` (`llama-server`, the TTS worker, the OpenVINO, TBB, hwloc and ONNX Runtime libraries, `resources/tts/ratings.json`) or a missing licence or notice, including `/usr/share/licenses/vaakora/LICENSE`;
- a bundled NPU driver;
- a missing weak dependency (RPM and `.deb`);
- Vaakora's own binaries linking `libssl` or `libcrypto`;
- any ELF that needs a glibc symbol version above `GLIBC_2.35`.

Every check runs and each failure prints one `refusing:` line, so one run shows every problem. It exits 0 with `verified <kind>: <file>`. Host tools: `rpm`, `rpm2cpio`, `cpio`, `ar`, `tar` with zstd, `readelf` and `od`.

## Arch package

```bash
packaging/arch-package.sh <absolute path of Vaakora_<version>_amd64.deb> <out-dir>
```

Repacks the `.deb` payload unchanged as `vaakora-<version>-1-x86_64.pkg.tar.zst` in `<out-dir>`, running `makepkg` without network in the image `vaakora-build:arch` (Arch Linux, from `packaging/arch/Containerfile`; building it the first time downloads the pinned base image and `fakeroot`). It refuses any other file name and builds in `packaging/.work/arch-build` from a copy of `packaging/arch/PKGBUILD` with the version and the `.deb`'s sha256 filled in; `makepkg` checks that sha256 before it unpacks the `.deb`. `build.sh` runs it on the `.deb` it has just verified, with `packaging/dist/` as `<out-dir>`. The packaging tests use the same `packaging/.work/arch-build`, so never run them while a build runs.

## Install test

```bash
packaging/install-test.sh <dist-dir> <version> [<target>...]
```

`build.sh` prints this as its next step. It installs each package in a fresh container of a target distribution (rootless `podman`, one target after another) and runs `packaging/install-smoke.sh` there as root. With no target it runs all 13:

| Target                  | Image                                  | Package  |
| ----------------------- | -------------------------------------- | -------- |
| `fedora-44`             | `registry.fedoraproject.org/fedora:44` | RPM      |
| `fedora-45`             | `registry.fedoraproject.org/fedora:45` | RPM      |
| `debian-12`             | `docker.io/library/debian:12`          | `.deb`   |
| `debian-13`             | `docker.io/library/debian:13`          | `.deb`   |
| `ubuntu-22.04`          | `docker.io/library/ubuntu:22.04`       | `.deb`   |
| `ubuntu-24.04`          | `docker.io/library/ubuntu:24.04`       | `.deb`   |
| `ubuntu-26.04`          | `docker.io/library/ubuntu:26.04`       | `.deb`   |
| `ubuntu-26.10`          | `docker.io/library/ubuntu:26.10`       | `.deb`   |
| `arch`                  | `docker.io/library/archlinux:latest`   | Arch     |
| `appimage-fedora-45`    | `registry.fedoraproject.org/fedora:45` | AppImage |
| `appimage-debian-12`    | `docker.io/library/debian:12`          | AppImage |
| `appimage-ubuntu-22.04` | `docker.io/library/ubuntu:22.04`       | AppImage |
| `appimage-arch`         | `docker.io/library/archlinux:latest`   | AppImage |

An unknown target, or a package that a requested target needs and `<dist-dir>` lacks, is a usage error (exit 2) before any container starts. Per target it pulls the image, reads its digest and starts the container with exactly two host paths mounted, both read-only: `<dist-dir>` at `/dist` and `install-smoke.sh` at `/smoke.sh`. It prints `PASS <target> <image>@<digest>` or `FAIL <target> <image>@<digest> (log: <path>)` (`@unknown` when the pull failed), runs every target even after a failure, and exits 1 if any target failed. Each target's full output is in `packaging/.work/logs/install-test-<UTC stamp>/<target>.log`; a container gets at most 1800 s. The containers need network for distribution packages (the package's dependencies and the AppImage baseline). No model is downloaded and nothing runs a model.

The smoke installs the package with the distribution's own tool:

- RPM: `dnf install` with weak dependencies off, so the hard dependencies alone must be enough;
- `.deb`: `apt-get install --no-install-recommends`;
- Arch: `pacman -Syu`, then `pacman -U`;
- AppImage: first the desktop baseline an AppImage leaves to the host (ALSA, Mesa EGL, GL, gbm and drm, fontconfig, freetype, harfbuzz, fribidi, X11 and xcb, expat, zlib, gpg-error, gmp, com_err and the OpenCL loader; the package names per distribution are in `install-smoke.sh`), then the AppImage is extracted and run with `APPIMAGE_EXTRACT_AND_RUN=1` (no FUSE in the container).

Then, with `D` the installed `/usr/lib/Vaakora` (for the AppImage, inside the extracted tree), it proves that:

- `vaakora --help` exits 0 and prints `Usage: vaakora` (the command line is parsed before the window starts, so no display is needed);
- `D/llm/llama-server --version` exits 0 and prints `version:`;
- `D/tts/vaakora-tts --list-devices`, in the environment the app gives the worker (`LD_LIBRARY_PATH` and `HANDY_OPENVINO_LIBRARY`), exits 0 and reports OpenVINO 2026.4 with the `CPU` device;
- `ldd` resolves every library of every ELF under `D` and of `vaakora` itself (for the AppImage, also its transcribe and ggml libraries), so GPU transcription (`libvulkan.so.1`) and Intel GPU read aloud (`libOpenCL.so.1`) do not lose their loaders. Each miss prints `UNRESOLVED <file>: <library> => not found`.

The log's last line is `SMOKE PASS` or `SMOKE FAIL: <reason>`. The install test runs neither under `systemd-run` nor with `--cgroups=split`: under pueue, split containers fail with crun's "controller 'pids' is not available", and these containers need no memory cap. The packaging tests run `install-test.sh` with a stub `podman` and write their own `install-test-<UTC stamp>` directories under `packaging/.work/logs`, so never run them while an install test runs.

## Pins

A sha256, digest or commit mismatch on any input below fails the build. The Ubuntu packages the release image installs with `apt-get` are not pinned beyond the base image digest; crates and bun packages come from `Cargo.lock` and `bun.lock`.

| Input                                        | Pin                                                                                                                                                                      | Where                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| Ubuntu base image                            | `docker.io/library/ubuntu:22.04@sha256:b000e69a50ff940390233025e7a337fb8469b509e2334fa4d018ac30f3e18cdb`                                                                 | `Containerfile.jammy` |
| Vulkan SDK (headers, `glslc`, SPIRV-Headers) | LunarG `1.4.350.1`, sha256 `6cce33c7e5383814150c5041820769d93c65a1fd883002e5949b067045a07daa`                                                                            | `Containerfile.jammy` |
| rustup                                       | `1.29.3`, sha256 `b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55`                                                                                      | `Containerfile.jammy` |
| Rust toolchain                               | `1.100.0` (with `rustfmt` and `clippy`)                                                                                                                                  | `Containerfile.jammy` |
| bun                                          | `1.4.5`, sha256 `94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb`                                                                                       | `Containerfile.jammy` |
| `AppRun-x86_64` (tauri AppImage tool)        | release `apprun-old`, sha256 `f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f`                                                                          | `Containerfile.jammy` |
| `linuxdeploy-x86_64.AppImage`                | release `linuxdeploy`, sha256 `e762bea85c8eb0d4b3508d46e5c1f037f717d0f9303ae3b4aafc8b04991fa1ef`                                                                         | `Containerfile.jammy` |
| `linuxdeploy-plugin-gtk.sh`                  | commit `dda522bce37387f1b853d9095713bfaa924c8423`, sha256 `7804c9eef13e59bf2783aad9882ef9db8f3f3f9e8d631874b1d348d550a3693f`                                             | `Containerfile.jammy` |
| `linuxdeploy-plugin-gstreamer.sh`            | commit `2a2e67491c32995a3f279ad0ecbe77abd512b42a`, sha256 `c107b49d84edbffc6ab226ed1007e0626a4f7aa2c3a36b7782bef62351d49e94`                                             | `Containerfile.jammy` |
| `linuxdeploy-plugin-appimage`                | release `1-alpha-20250213-1`, sha256 `992d502a248e14ab185448ddf6f6e7d25558cb84d4623c354c3af350c25fccb3`                                                                  | `Containerfile.jammy` |
| ONNX Runtime                                 | Microsoft `1.31.0` NuGet package, sha256 `7e35fdb4f5adb62f01e60798e2e5ed05108f5fbbe1cca03fbcc37903cf7c5e3b`                                                              | `Containerfile.jammy` |
| Arch Linux base image                        | `docker.io/library/archlinux:latest@sha256:375a401bb3c6376b37f40b6dfa25067db37ec78d0b7af67ae6315f43a0184a9d`                                                             | `arch/Containerfile`  |
| `fakeroot`                                   | `2:1.37.2-1` from the Arch Linux Archive, sha256 `32f9007ed57ee5286895c812238d08354d3b6831039f74be057f72d07c3fe067`                                                      | `arch/Containerfile`  |
| llama.cpp                                    | tag `b11260`, commit `e904318a2d3e2382e78c98b4353c5dd569c079f6` (refused on a mismatch)                                                                                  | `llama-server.sh`     |
| OpenVINO runtime                             | wheel `openvino-2026.4.1-22982-cp313-cp313-manylinux_2_28_x86_64.whl`, sha256 `a9b637846c579d7b81b17b6585e0c7b1947574e8d13cf83d7307ce50cd2c352e` (refused on a mismatch) | `openvino-runtime.sh` |

The tauri AppImage tools are copied into tauri's cache before it bundles, so tauri runs the pinned copies instead of downloading its own. The TTS worker links that ONNX Runtime dynamically (Microsoft's 1.31.0 build needs glibc 2.28; the prebuilt static one needs 2.38), and the packages ship it next to the worker.

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
