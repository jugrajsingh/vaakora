#!/usr/bin/env bash
# Verify one built package (.rpm, .deb, Arch .pkg.tar.zst or AppImage) from its unpacked payload.
# Every check runs and each failure prints one "refusing:" line, so one run shows every problem; a failing tool aborts at once.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR=/usr/lib/Vaakora
LICENCE=/usr/share/licenses/vaakora/LICENSE
# Ubuntu 22.04's glibc: the oldest target release.
GLIBC_CEILING=2.35

usage() {
  echo 'usage: verify-package.sh ABSOLUTE_FILE (.rpm, .deb, .pkg.tar.zst or .AppImage)' >&2
  exit 2
}

if [[ $# -ne 1 || "$1" != /* || ! -f "$1" ]]; then
  usage
fi
file=$1
case "$file" in
  *.rpm) kind=rpm ;;
  *.deb) kind=deb ;;
  *.pkg.tar.zst) kind=arch ;;
  *.AppImage) kind=appimage ;;
  *) usage ;;
esac

failed=0
refuse() {
  echo "refusing: $*" >&2
  failed=1
}

mkdir -p "$HERE/.work"
payload=$(mktemp -d "$HERE/.work/verify.XXXXXX")
# Unpacked modes can lack u+w; restore it so the cleanup removes everything even after an aborted unpack.
trap 'chmod -R u+rwX "$payload" 2>/dev/null; rm -rf "$payload"' EXIT
root=$payload/root
case "$kind" in
  rpm)
    mkdir "$root"
    (cd "$root" && rpm2cpio "$file" | cpio -idm --quiet)
    ;;
  deb)
    mkdir "$root" "$payload/deb" "$payload/control"
    (cd "$payload/deb" && ar x "$file")
    tar -xf "$payload"/deb/control.tar.* -C "$payload/control"
    tar -xf "$payload"/deb/data.tar.* -C "$root"
    ;;
  arch)
    mkdir "$root"
    tar --zstd -xf "$file" -C "$root"
    ;;
  appimage)
    (cd "$payload" && "$file" --appimage-extract >/dev/null)
    root=$payload/squashfs-root
    ;;
esac
chmod -R u+rwX "$payload"

required=(resources/tts/ratings.json llm/llama-server tts/vaakora-tts tts/libopenvino.so.2641 tts/libopenvino_c.so.2641 tts/libopenvino_onnx_frontend.so.2641 tts/libopenvino_ir_frontend.so.2641 tts/libopenvino_intel_cpu_plugin.so tts/libopenvino_intel_gpu_plugin.so tts/libopenvino_intel_npu_plugin.so tts/libtbb.so.12 tts/libhwloc.so.15 tts/libonnxruntime.so.1)
required+=(tts/notices/LICENSE tts/notices/licensing/runtime-third-party-programs.txt tts/notices/licensing/onetbb_third-party-programs.txt tts/notices/licensing/onednn_third-party-programs.txt tts/notices/INDIC-TINY-TTS-CODE-LICENSE tts/notices/onnxruntime/LICENSE tts/notices/onnxruntime/ThirdPartyNotices.txt)
for path in "${required[@]/#/$INSTALL_DIR/}" "$LICENCE"; do
  if [[ ! -f "$root$path" ]]; then
    refuse "missing $path"
  fi
done

find "$root" -mindepth 1 -printf '/%P\n' >"$payload/paths"
if grep -Eiq '/(libze_intel_npu|intel_npu|npu_driver)' "$payload/paths"; then
  refuse "$kind bundles an NPU driver"
fi

weak=()
case "$kind" in
  rpm)
    weak=(intel-compute-runtime intel-level-zero oneapi-level-zero wl-clipboard)
    present=$(rpm -qp --recommends "$file")
    ;;
  deb)
    weak=(intel-opencl-icd libze1 libze-intel-gpu1 wl-clipboard)
    # Recommends: a, b (>= 1) | c  ->  one package name per line.
    present=$(sed -n '/^Recommends:/{s/^Recommends://; s/([^)]*)//g; s/[[:space:]]//g; s/[,|]/\n/g; p}' "$payload/control/control")
    ;;
esac
for dependency in "${weak[@]}"; do
  if ! grep -Fxq "$dependency" <<<"$present"; then
    refuse "missing weak dependency $dependency"
  fi
done

# readelf reads each ELF without running the loader, so this covers every binary and bundled library in the package.
find "$root" -type f -print0 >"$payload/files"
elves=()
while IFS= read -r -d '' path; do
  magic=$(od -An -tx1 -N4 "$path")
  if [[ "${magic//[[:space:]]/}" == 7f454c46 ]]; then
    elves+=("$path")
  fi
done <"$payload/files"

# Only Vaakora's own ELFs must stay on rustls; libraries an AppImage bundles from the build image may link OpenSSL.
for path in "${elves[@]}"; do
  name=${path#"$root"}
  case "$name" in
    /usr/bin/vaakora | "$INSTALL_DIR"/* | /usr/lib/libtranscribe* | /usr/lib/libggml*) ;;
    *) continue ;;
  esac
  dynamic=$(readelf -d "$path")
  if grep -Eq 'NEEDED.*\[lib(ssl|crypto)\.so' <<<"$dynamic"; then
    refuse "$name links libssl or libcrypto"
  fi
done

for path in "${elves[@]}"; do
  versions=$(readelf -V --wide "$path")
  needed=$({ grep -oE '\bGLIBC_[0-9]+(\.[0-9]+)+' <<<"$versions" || true; } | sed 's/^GLIBC_//' | sort -V | tail -n 1)
  if [[ -n "$needed" && "$(printf '%s\n' "$GLIBC_CEILING" "$needed" | sort -V | tail -n 1)" != "$GLIBC_CEILING" ]]; then
    refuse "${path#"$root"} needs GLIBC_$needed, above GLIBC_$GLIBC_CEILING"
  fi
done

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi
echo "verified $kind: $file"
