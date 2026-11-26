#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 5 || "$1" != /* || "$2" != /* || "$3" != /* || "$4" != /* || "$5" != /* || -z ${CARGO_TARGET_DIR:-} || -z ${HANDY_VERSION:-} || -z ${ORT_LIB_PATH:-} || -z ${TAURI_TOOLS:-} ]]; then
  echo 'usage: build-tts-inner.sh SOURCE OPENVINO_LIBS STAGER OUTPUT OPENVINO_NOTICES with CARGO_TARGET_DIR, HANDY_VERSION, ORT_LIB_PATH and TAURI_TOOLS' >&2
  exit 2
fi
source_root=$1
runtime=$2
stager=$3
output=$4
notices=$5
cd "$source_root"
staging="$source_root/.build-tmp/rpm-stage"
rm -rf "$staging" "$source_root/src-tauri/tts-bin"
mkdir -p "$source_root/.build-tmp"
# The worker links ONNX Runtime dynamically and loads the copy shipped next to it. The rpath goes to the final link only, so dependency builds stay cached.
# shellcheck disable=SC2016 # $ORIGIN is for the dynamic loader, not the shell
cargo rustc --locked --release --package handy-tts --bin vaakora-tts -- -C 'link-arg=-Wl,-rpath,$ORIGIN'
bash "$stager" "$CARGO_TARGET_DIR/release/vaakora-tts" "$runtime" "$staging" "$notices"
mkdir -p "$source_root/src-tauri/tts-bin"
cp -a "$staging/usr/lib/Vaakora/tts/." "$source_root/src-tauri/tts-bin/"
install -D -m 0644 "$source_root/crates/handy-tts/INDIC-TINY-TTS-CODE-LICENSE" "$source_root/src-tauri/tts-bin/notices/INDIC-TINY-TTS-CODE-LICENSE"
install -m 0644 "$ORT_LIB_PATH/libonnxruntime.so.1" "$source_root/src-tauri/tts-bin/"
install -D -m 0644 -t "$source_root/src-tauri/tts-bin/notices/onnxruntime" "$ORT_LIB_PATH/../notices/LICENSE" "$ORT_LIB_PATH/../notices/ThirdPartyNotices.txt"
bun install --frozen-lockfile
bun run build
# tauri downloads only the AppImage tools missing from ~/.cache/tauri, so the pinned copies from the image are the ones it runs.
mkdir -p "$HOME/.cache/tauri"
install -m 0755 "$TAURI_TOOLS"/* "$HOME/.cache/tauri/"
bundle="$CARGO_TARGET_DIR/release/bundle"
rm -rf "$bundle"
bun run tauri build --bundles deb,rpm,appimage --config '{"bundle":{"createUpdaterArtifacts":false}}'
artifacts=(
  "rpm/Vaakora-$HANDY_VERSION-1.x86_64.rpm"
  "deb/Vaakora_${HANDY_VERSION}_amd64.deb"
  "appimage/Vaakora_${HANDY_VERSION}_amd64.AppImage"
)
for artifact in "${artifacts[@]}"; do
  if [[ ! -f "$bundle/$artifact" ]]; then
    echo "refusing: tauri wrote no ${artifact#*/}" >&2
    exit 1
  fi
done
for artifact in "${artifacts[@]}"; do
  cp -v "$bundle/$artifact" "$output/"
done
