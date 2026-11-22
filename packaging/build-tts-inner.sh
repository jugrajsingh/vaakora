#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 5 || "$1" != /* || "$2" != /* || "$3" != /* || "$4" != /* || "$5" != /* || -z ${CARGO_TARGET_DIR:-} || -z ${HANDY_VERSION:-} ]]; then
  echo 'usage: build-tts-inner.sh SOURCE OPENVINO_LIBS STAGER OUTPUT OPENVINO_NOTICES with CARGO_TARGET_DIR and HANDY_VERSION' >&2
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
cargo build --locked --release --package handy-tts --bin vaakora-tts
bash "$stager" "$CARGO_TARGET_DIR/release/vaakora-tts" "$runtime" "$staging" "$notices"
mkdir -p "$source_root/src-tauri/tts-bin"
cp -a "$staging/usr/lib/Vaakora/tts/." "$source_root/src-tauri/tts-bin/"
install -D -m 0644 "$source_root/crates/handy-tts/INDIC-TINY-TTS-CODE-LICENSE" "$source_root/src-tauri/tts-bin/notices/INDIC-TINY-TTS-CODE-LICENSE"
bun install --frozen-lockfile
bun run build
shopt -s nullglob
for artifact in "$CARGO_TARGET_DIR"/release/bundle/rpm/*-"$HANDY_VERSION"-*.rpm; do
  rm -f -- "$artifact"
done
bun run tauri build --bundles rpm --config '{"bundle":{"createUpdaterArtifacts":false}}'
found=0
shopt -s nullglob
for artifact in "$CARGO_TARGET_DIR"/release/bundle/rpm/*-"$HANDY_VERSION"-*.rpm; do
  cp -v "$artifact" "$output/"
  found=1
done
test "$found" -eq 1
