#!/usr/bin/env bash
# Build and verify the RPM, .deb, Arch package and AppImage from HEAD of this repository, inside rootless podman.
set -euo pipefail

usage() {
  echo "usage: $0 [--stage-only] [--cpu x86-64-v3|native]" >&2
  exit 2
}

stage_only=0
cpu=x86-64-v3
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    --stage-only) stage_only=1 ;;
    --cpu)
      i=$((i + 1))
      [[ $i -lt ${#args[@]} ]] || usage
      cpu="${args[$i]}"
      ;;
    *) usage ;;
  esac
done
case "$cpu" in
  x86-64-v3 | native) ;;
  *) usage ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
WORK="$HERE/.work"
SRC="$WORK/src"
DIST="$HERE/dist"
LOGS="$WORK/logs"
IMAGE=vaakora-build:jammy
# The release image has its own cache volumes (vaakora-jammy-*), apart from dev.sh's: nothing built against Fedora's libraries is reused.
TARGET_VOL=vaakora-jammy-target

if [[ -n "$(git -C "$REPO" status --porcelain)" ]]; then
  echo "refusing: $REPO is dirty; commit or stash first (the build archives HEAD)" >&2
  exit 1
fi

mkdir -p "$LOGS" "$DIST"
LOG="$LOGS/build-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$LOG") 2>&1
echo "log: $LOG"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$HERE/lib.sh"

sha="$(git -C "$REPO" rev-parse HEAD)"
version="$(git -C "$REPO" show "$sha:src-tauri/tauri.conf.json" | jq -er .version)"

rm -rf "$SRC"
mkdir -p "$SRC"
git -C "$REPO" archive --format=tar "$sha" | tar -x -C "$SRC"
echo "$sha" >"$SRC/.vaakora-sha"

echo "staged: $sha version $version in $SRC"
if [[ "$stage_only" -eq 1 ]]; then
  exit 0
fi
mkdir -p "$SRC/.build-tmp"
export TMPDIR="$SRC/.build-tmp"

if [[ "$(podman info --format '{{.Host.Security.Rootless}}')" != true ]]; then
  echo "refusing: podman is not rootless" >&2
  exit 1
fi

mkdir -p "$WORK/image-context"
podman build -f "$HERE/Containerfile.jammy" -t "$IMAGE" "$WORK/image-context"

for vol in vaakora-jammy-cargo vaakora-jammy-bun "$TARGET_VOL" vaakora-jammy-ortcache; do
  podman volume exists "$vol" || podman volume create "$vol" >/dev/null
done

bash "$HERE/llama-server.sh" "$SRC/src-tauri/llm-bin" --cpu "$cpu"

TTS_RUNTIME="$WORK/tts-runtime-2026.4.1"
bash "$HERE/openvino-runtime.sh" "$TTS_RUNTIME"
TTS_NOTICES="$TTS_RUNTIME/notices"

# The build container reads the scripts from a copy under .work so SELinux labels never touch the tracked files.
KIT="$WORK/kit"
rm -rf "$KIT"
mkdir -p "$KIT"
cp "$HERE/stage-tts.sh" "$HERE/build-tts-inner.sh" "$KIT/"

tty_flag=()
if [[ -t 0 && -t 1 ]]; then
  tty_flag=(-t)
fi

stdbuf -oL -eL podman run --rm --userns=keep-id "${tty_flag[@]}" \
  -e "HANDY_VERSION=$version" \
  -e TMPDIR=/src/.build-tmp \
  -v "$TTS_NOTICES:/ov-notices:ro,z" \
  -v "$KIT:/kit:ro,z" \
  -v "$TTS_RUNTIME:/ov:ro,z" \
  -v "$SRC:/src:z" \
  -v "$DIST:/out:z" \
  -v vaakora-jammy-cargo:/cache/cargo:z \
  -v vaakora-jammy-bun:/cache/bun:z \
  -v "$TARGET_VOL":/cache/target:z \
  -v vaakora-jammy-ortcache:/home/builder/.cache:z \
  "$IMAGE" bash /kit/build-tts-inner.sh /src /ov /kit/stage-tts.sh /out /ov-notices

name="$(sed -n '/^\[package\]/,/^\[/{s/^name = "\(.*\)"/\1/p}' "$SRC/src-tauri/Cargo.toml" | head -1)"
rpm="$(select_rpm "$DIST" "$name" "$version")"
deb="$DIST/Vaakora_${version}_amd64.deb"
appimage="$DIST/Vaakora_${version}_amd64.AppImage"
for package in "$deb" "$appimage"; do
  if [[ ! -f "$package" ]]; then
    echo "refusing: tauri wrote no ${package##*/}" >&2
    exit 1
  fi
done
bash "$HERE/verify-package.sh" "$rpm"
bash "$HERE/verify-package.sh" "$deb"
# arch-package.sh prints its own "built:" line; build.sh prints one per package only after all four are verified.
bash "$HERE/arch-package.sh" "$deb" "$DIST" | sed -u '/^built: /d'
arch="$DIST/vaakora-$version-1-x86_64.pkg.tar.zst"
bash "$HERE/verify-package.sh" "$arch"
bash "$HERE/verify-package.sh" "$appimage"
for package in "$rpm" "$deb" "$arch" "$appimage"; do
  echo "built: $package"
done
echo "next: $HERE/install-test.sh $DIST $version"
echo "next: $HERE/install.sh"
