#!/usr/bin/env bash
# Build the static CPU-only llama-server in the build image and install it into <out-dir>.
set -euo pipefail

usage() {
  echo "usage: $0 <out-dir> [--cpu x86-64-v3|native]" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
out_dir="$1"
shift
cpu=x86-64-v3
case "$#" in
  0) ;;
  2)
    [[ "$1" == --cpu ]] || usage
    cpu="$2"
    ;;
  *) usage ;;
esac
case "$cpu" in
  x86-64-v3) cpu_flags='-DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON' ;;
  native) cpu_flags='-DGGML_NATIVE=ON' ;;
  *) usage ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$HERE/.work"
IMAGE=vaakora-build:fedora45
LLAMA_TAG=b11260
LLAMA_COMMIT=e904318a2d3e2382e78c98b4353c5dd569c079f6
LLAMA_SRC="$WORK/llama.cpp"
LLAMA_OUT="$WORK/llm-bin-$LLAMA_COMMIT-$cpu"
LLAMA_BUILD="$WORK/llama-build-$cpu"

if [[ ! -x "$LLAMA_OUT/llama-server" ]]; then
  if [[ ! -d "$LLAMA_SRC/.git" ]]; then
    git clone --depth 1 --branch "$LLAMA_TAG" https://github.com/ggml-org/llama.cpp "$LLAMA_SRC"
  fi
  llama_have="$(git -C "$LLAMA_SRC" rev-parse HEAD)"
  if [[ "$llama_have" != "$LLAMA_COMMIT" ]]; then
    echo "refusing: $LLAMA_SRC is at $llama_have, want $LLAMA_TAG = $LLAMA_COMMIT" >&2
    exit 1
  fi
  mkdir -p "$LLAMA_OUT" "$LLAMA_BUILD"
  # shellcheck disable=SC2016 # variables expand inside the container
  llama_inner='set -euo pipefail
cmake -S /llama -B /work/llama-build -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF '"$cpu_flags"' -DGGML_OPENMP=OFF \
  -DGGML_VULKAN=OFF -DGGML_BLAS=OFF -DLLAMA_OPENSSL=OFF \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF
cmake --build /work/llama-build --target llama-server -j "$(nproc)"
install -D -m 0755 /work/llama-build/bin/llama-server /out/llama-server'
  stdbuf -oL -eL podman run --rm --userns=keep-id \
    -e TMPDIR=/work/llama-build \
    -v "$LLAMA_SRC:/llama:ro,z" \
    -v "$LLAMA_OUT:/out:z" \
    -v "$LLAMA_BUILD:/work/llama-build:z" \
    "$IMAGE" bash -c "$llama_inner"
fi
if grep -q 'not found' < <(ldd "$LLAMA_OUT/llama-server"); then
  echo "refusing: $LLAMA_OUT/llama-server has unresolved shared libraries" >&2
  exit 1
fi
install -D -m 0755 "$LLAMA_OUT/llama-server" "$out_dir/llama-server"
echo "staged: llama-server $LLAMA_TAG ($LLAMA_COMMIT, cpu $cpu) at $out_dir/llama-server"
