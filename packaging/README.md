# Packaging

Builds the Linux RPM from this repository inside rootless podman. Everything the build needs is here; nothing outside the repository is read.

## Requirements

- Fedora host with rootless `podman`, `git`, `jq`, `curl`, `python3`, `rpm` and `sha256sum`. The host needs no `-devel` packages.
- Network access on the first run (Fedora image, crates, bun packages, the pinned llama.cpp tag and the pinned OpenVINO wheel).

## Build

```bash
packaging/build.sh [--stage-only] [--cpu x86-64-v3|native]
```

- Refuses a dirty tree: the build archives `HEAD` into `packaging/.work/src` (the commit is recorded in `packaging/.work/src/.vaakora-sha`). Commit first.
- The version comes from `src-tauri/tauri.conf.json` at `HEAD`.
- Builds the image `vaakora-build:fedora45` from `packaging/Containerfile` and uses the volumes `vaakora-cargo`, `vaakora-bun`, `vaakora-target` and `vaakora-ortcache`. The first build is cold: expect a long compile.
- `--cpu x86-64-v3` (default) builds `llama-server` for any CPU with AVX2, FMA and F16C. `--cpu native` tunes it to the build machine and may crash with an illegal instruction on other CPUs.
- The RPM lands in `packaging/dist/` and `packaging/verify-rpm.sh` checks its contents.

## Pins

| Input            | Pin                                                                                                                                                                      | Script                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| llama.cpp        | tag `b11260`, commit `e904318a2d3e2382e78c98b4353c5dd569c079f6` (refused on a mismatch)                                                                                  | `llama-server.sh`     |
| OpenVINO runtime | wheel `openvino-2026.4.1-22982-cp313-cp313-manylinux_2_28_x86_64.whl`, sha256 `a9b637846c579d7b81b17b6585e0c7b1947574e8d13cf83d7307ce50cd2c352e` (refused on a mismatch) | `openvino-runtime.sh` |

`packaging/llama-server.sh <out-dir> [--cpu ...]` and `packaging/openvino-runtime.sh <dest-dir> [--wheel <file>]` can be run on their own. The OpenVINO wheel and the built binaries are cached under `packaging/.work/`; the llama.cpp git clone lives outside the checkout, in `${XDG_CACHE_HOME:-$HOME/.cache}/vaakora-build/llama.cpp`, so the checkout never holds a nested `.git`.

## Install

```bash
packaging/install.sh [--dry-run]
```

Picks the newest RPM in `packaging/dist/` whose name and version match this checkout and runs `sudo dnf` install, upgrade, downgrade or reinstall with `--nogpgcheck` (the local RPM is unsigned).

The bootstrap build still names the package `handy`: do not install it. Install only after the rebrand has renamed the package.

## Dev loop

```bash
packaging/dev.sh [--mount <host-path>:<container-path>]... [--env NAME=VALUE]... [--device /dev/dri/renderD128] [--device /dev/accel/accel0] <checkout> <command> [args...]
```

Runs one command (cargo, bun, ...) in `/src` inside the build image, with its own caches. Mounts are read-only and devices are opt-in. The image must already exist, so run `build.sh` once first.

## Tests

```bash
python3 -I -m unittest discover -s packaging/tests -t packaging/tests
```

Fixtures live under `packaging/.work/test-scratch` (override with `VAAKORA_TEST_SCRATCH`, which must stay inside the repository).
