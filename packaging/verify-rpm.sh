#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR=/usr/lib/Vaakora
WORKER=vaakora-tts
LICENCE=/usr/share/licenses/vaakora/LICENSE
if [[ $# -ne 1 || "$1" != /* || ! -f "$1" ]]; then
  echo 'usage: verify-rpm.sh ABSOLUTE_RPM_FILE' >&2
  exit 2
fi
package=$1
files=$(rpm -qlp "$package")
dependencies=$(rpm -qp --recommends "$package")
required=(resources/tts/ratings.json llm/llama-server "tts/$WORKER" tts/libopenvino.so.2641 tts/libopenvino_c.so.2641 tts/libopenvino_onnx_frontend.so.2641 tts/libopenvino_ir_frontend.so.2641 tts/libopenvino_intel_cpu_plugin.so tts/libopenvino_intel_gpu_plugin.so tts/libopenvino_intel_npu_plugin.so tts/libtbb.so.12 tts/libhwloc.so.15)
required+=(tts/notices/LICENSE tts/notices/licensing/runtime-third-party-programs.txt tts/notices/licensing/onetbb_third-party-programs.txt tts/notices/licensing/onednn_third-party-programs.txt tts/notices/INDIC-TINY-TTS-CODE-LICENSE)
for path in "${required[@]}"; do
  if ! grep -Fxq "$INSTALL_DIR/$path" <<<"$files"; then
    echo "refusing: missing $INSTALL_DIR/$path" >&2
    exit 1
  fi
done
if ! grep -Fxq "$LICENCE" <<<"$files"; then
  echo "refusing: missing $LICENCE" >&2
  exit 1
fi
if grep -Eiq '/(libze_intel_npu|intel_npu|npu_driver)' <<<"$files"; then
  echo 'refusing: RPM bundles an NPU driver' >&2
  exit 1
fi
for dependency in intel-compute-runtime intel-level-zero oneapi-level-zero wl-clipboard; do
  if ! grep -Fxq "$dependency" <<<"$dependencies"; then
    echo "refusing: missing weak dependency $dependency" >&2
    exit 1
  fi
done
echo 'RPM TTS files, runtime plugins and weak dependencies verified'
