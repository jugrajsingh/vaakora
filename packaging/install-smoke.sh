#!/usr/bin/env bash
# Runs as root inside a clean distro container (install-test.sh mounts it at /smoke.sh): installs one Vaakora package,
# then checks that the app, llama-server and the TTS worker start and that every library they load resolves.
# With --installed it installs nothing: the package is already there (put there by docs/install.sh) and is only checked.
# Last line: "SMOKE PASS", or "SMOKE FAIL: <reason>" with exit 1.
# -E carries the ERR trap into functions, so any failing step still ends on a SMOKE FAIL line.
set -Eeuo pipefail

fail() {
  echo "SMOKE FAIL: $*"
  exit 1
}
trap 'rc=$?; echo "SMOKE FAIL: \"$BASH_COMMAND\" exited $rc"; exit 1' ERR

installed=0
if [[ "${1:-}" == --installed ]]; then
  installed=1
  shift
  usage="usage: install-smoke.sh --installed rpm|deb|arch|appimage [FILE] (FILE is required for appimage)"
  [[ $# -ge 1 && $# -le 2 ]] || fail "$usage"
  kind="$1"
  file="${2:-}"
  case "$kind" in
    rpm | deb | arch) ;;
    appimage) [[ -n "$file" ]] || fail "$usage" ;;
    *) fail "$usage" ;;
  esac
  [[ -z "$file" || -f "$file" ]] || fail "no such file: $file"
else
  usage="usage: install-smoke.sh rpm|deb|arch|appimage FILE"
  [[ $# -eq 2 ]] || fail "$usage"
  kind="$1"
  file="$2"
  case "$kind" in
    rpm | deb | arch | appimage) ;;
    *) fail "$usage" ;;
  esac
  [[ -f "$file" ]] || fail "no such file: $file"
fi

# shellcheck source=/dev/null
. /etc/os-release

# The libraries an AppImage leaves to the host (linuxdeploy's exclude list) plus the OpenCL loader.
appimage_baseline() {
  case "$ID" in
    fedora)
      dnf install -y --setopt=install_weak_deps=False alsa-lib mesa-libEGL mesa-libGL mesa-libgbm libdrm fontconfig \
        freetype harfbuzz fribidi libX11 libX11-xcb libxcb expat zlib-ng-compat libgpg-error gmp libcom_err ocl-icd
      ;;
    debian | ubuntu)
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libasound2 libegl1 libgl1 libgbm1 \
        libdrm2 libfontconfig1 libfreetype6 libharfbuzz0b libfribidi0 libx11-6 libx11-xcb1 libxcb1 libexpat1 zlib1g \
        libgpg-error0 libgmp10 libcom-err2 ocl-icd-libopencl1
      ;;
    arch)
      pacman -Syu --noconfirm --needed alsa-lib libglvnd mesa libdrm fontconfig freetype2 harfbuzz fribidi libx11 \
        libxcb expat zlib libgpg-error gmp e2fsprogs ocl-icd
      ;;
    *) fail "no AppImage baseline for ID=$ID" ;;
  esac
}

root=
app=(vaakora)
case "$kind" in
  rpm)
    if [[ "$installed" -eq 1 ]]; then rpm -q vaakora; else dnf install -y --setopt=install_weak_deps=False "$file"; fi
    ;;
  deb)
    if [[ "$installed" -eq 1 ]]; then
      dpkg -s vaakora
    else
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$file"
    fi
    ;;
  arch)
    if [[ "$installed" -eq 1 ]]; then
      pacman -Q vaakora
    else
      pacman -Syu --noconfirm
      pacman -U --noconfirm "$file"
    fi
    ;;
  appimage)
    appimage_baseline
    mkdir -p /work
    cp "$file" /work/app.AppImage
    chmod +x /work/app.AppImage
    cd /work
    ./app.AppImage --appimage-extract >/dev/null
    cd /
    root=/work/squashfs-root
    app=(env APPIMAGE_EXTRACT_AND_RUN=1 /work/app.AppImage)
    ;;
esac

D="$root/usr/lib/Vaakora"
problems=()

# expect <label> <exit code> <output> <needle>...: the command exited 0 and printed every needle.
expect() {
  local label="$1" rc="$2" out="$3" needle
  shift 3
  printf '== %s (exit %s)\n%s\n' "$label" "$rc" "$out"
  if [[ "$rc" -ne 0 ]]; then
    problems+=("$label exited $rc: $(head -n 1 <<<"$out")")
    return 0
  fi
  for needle in "$@"; do
    if [[ "$out" != *"$needle"* ]]; then
      problems+=("$label printed no $needle")
    fi
  done
}

rc=0
out="$("${app[@]}" --help 2>&1)" || rc=$?
expect "vaakora --help" "$rc" "$out" "Usage: vaakora"

rc=0
out="$("$D/llm/llama-server" --version 2>&1)" || rc=$?
expect "llama-server --version" "$rc" "$out" "version:"

# The environment the app gives the worker (src-tauri/src/tts/service.rs).
rc=0
out="$(LD_LIBRARY_PATH="$D/tts" HANDY_OPENVINO_LIBRARY="$D/tts/libopenvino_c.so.2641" "$D/tts/vaakora-tts" --list-devices 2>&1)" || rc=$?
expect "vaakora-tts --list-devices" "$rc" "$out" '"openvino":"2026.4' '"CPU"'

# ldd on every ELF under D and on the app binary (AppImage: also the transcribe and ggml libraries next to it).
# Never all of /usr/bin: distro images carry unrelated binaries with unresolved libraries.
command -v ldd >/dev/null || fail "ldd is missing"
[[ -d "$D" ]] || fail "no $D"
candidates=()
mapfile -d '' -t candidates < <(find "$D" -type f -print0)
candidates+=("$root/usr/bin/vaakora")
if [[ "$kind" == appimage ]]; then
  mapfile -d '' -t -O "${#candidates[@]}" candidates < <(
    find "$root/usr/lib" -maxdepth 1 -type f \( -name 'libtranscribe*' -o -name 'libggml*' \) -print0
  )
fi
elves=0
unresolved=()
# ldd repeats a diagnostic once per library that needs it; report each file and diagnostic once.
declare -A seen=()
for f in "${candidates[@]}"; do
  if [[ "$(od -An -tx1 -N4 "$f" | tr -d ' \n')" != 7f454c46 ]]; then
    continue
  fi
  elves=$((elves + 1))
  # Neither exit status tells: ldd exits non-zero on a static ELF and 0 on a missing symbol version. Every "not found"
  # line counts: "<lib> => not found" (missing library) and "version `X' not found (required by ...)".
  lines="$(ldd "$f" 2>&1)" || true
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    if [[ "$line" == *"not found"* && -z "${seen["$f: $line"]:-}" ]]; then
      seen["$f: $line"]=1
      echo "UNRESOLVED $f: $line"
      unresolved+=("$f: $line")
    fi
  done <<<"$lines"
done
echo "== ldd: $elves ELF files, ${#unresolved[@]} unresolved"
if [[ "${#unresolved[@]}" -gt 0 ]]; then
  list="$(printf '%s, ' "${unresolved[@]}")"
  problems+=("unresolved libraries: ${list%, }")
fi

if [[ "${#problems[@]}" -gt 0 ]]; then
  reason="$(printf '%s; ' "${problems[@]}")"
  fail "${reason%; }"
fi
echo "SMOKE PASS"
