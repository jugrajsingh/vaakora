#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 4 ]]; then
  echo 'usage: stage-tts.sh WORKER OPENVINO_LIBS STAGING_ROOT OPENVINO_NOTICES' >&2
  exit 2
fi
worker=$1
runtime=$2
staging=$3
notices=$4
if [[ ! -x "$worker" || ! -d "$runtime" || "$staging" != /* || "$staging" == / ]]; then
  echo 'refusing invalid worker, runtime or explicit staging root' >&2
  exit 2
fi
required=(libopenvino.so.2641 libopenvino_c.so.2641 libopenvino_onnx_frontend.so.2641 libopenvino_ir_frontend.so.2641 libopenvino_intel_cpu_plugin.so libopenvino_intel_gpu_plugin.so libopenvino_intel_npu_plugin.so libtbb.so.12 libhwloc.so.15)
for library in "${required[@]}"; do
  if [[ ! -f "$runtime/$library" ]]; then
    echo "missing OpenVINO 2026.4.1 library: $library" >&2
    exit 1
  fi
done
notice_files=(LICENSE licensing/runtime-third-party-programs.txt licensing/onetbb_third-party-programs.txt licensing/onednn_third-party-programs.txt)
for notice in "${notice_files[@]}"; do
  if [[ ! -s "$notices/$notice" ]]; then
    echo "missing OpenVINO notice: $notice" >&2
    exit 1
  fi
done
destination="$staging/usr/lib/Handy/tts"
mkdir -p "$destination"
install -m 0755 "$worker" "$destination/handy-tts"
for library in "${required[@]}"; do
  install -m 0644 "$runtime/$library" "$destination/$library"
done
for library in "$runtime"/libtbbbind*.so.* "$runtime"/libtbbmalloc*.so.*; do
  if [[ -f "$library" ]]; then
    install -m 0644 "$library" "$destination/$(basename "$library")"
  fi
done
if compgen -G "$destination/libze_intel_npu*" >/dev/null; then
  echo 'NPU user-space driver must never be bundled' >&2
  exit 1
fi
for notice in "${notice_files[@]}"; do
  install -D -m 0644 "$notices/$notice" "$destination/notices/$notice"
done
echo "staged handy-tts and OpenVINO 2026.4.1 runtime into $destination"
