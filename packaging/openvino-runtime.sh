#!/usr/bin/env bash
# Fetch the pinned OpenVINO 2026.4.1 wheel (sha256-checked) and extract the TTS runtime libraries and notices into <dest-dir>.
set -euo pipefail

usage() {
  echo "usage: $0 <dest-dir> [--wheel <file>]" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
dest="$1"
shift
wheel_arg=""
case "$#" in
  0) ;;
  2)
    [[ "$1" == --wheel ]] || usage
    wheel_arg="$2"
    ;;
  *) usage ;;
esac
if [[ "$dest" != /* || "$dest" == / ]]; then
  echo "refusing: <dest-dir> must be an absolute directory other than /" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$HERE/.work"
WHEEL_NAME=openvino-2026.4.1-22982-cp313-cp313-manylinux_2_28_x86_64.whl
WHEEL_URL=https://files.pythonhosted.org/packages/7f/8b/d2fb2611cd8160cb4c0e5401b9d87312961d77891eade431381e396a8d83/$WHEEL_NAME
WHEEL_SHA256=a9b637846c579d7b81b17b6585e0c7b1947574e8d13cf83d7307ce50cd2c352e

wheel_ok() {
  local have
  have="$(sha256sum "$1" | cut -d' ' -f1)"
  [[ "$have" == "$WHEEL_SHA256" ]]
}

if [[ -n "$wheel_arg" ]]; then
  wheel="$wheel_arg"
  if [[ ! -f "$wheel" ]]; then
    echo "refusing: wheel $wheel does not exist" >&2
    exit 1
  fi
else
  wheel="$WORK/openvino-wheel/$WHEEL_NAME"
  if [[ ! -f "$wheel" ]]; then
    mkdir -p "$WORK/openvino-wheel"
    curl -fsSL --proto '=https' -o "$wheel.part" "$WHEEL_URL"
    mv "$wheel.part" "$wheel"
  fi
fi
if ! wheel_ok "$wheel"; then
  echo "refusing: $wheel does not match the pinned sha256 $WHEEL_SHA256" >&2
  exit 1
fi

mkdir -p "$WORK"
tmp="$(mktemp -d "$WORK/openvino-extract.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
python3 -I - "$wheel" "$tmp" <<'PY'
import fnmatch
import shutil
import sys
import zipfile
from pathlib import Path

wheel, out = sys.argv[1], Path(sys.argv[2])
required = [
    "libopenvino.so.2641",
    "libopenvino_c.so.2641",
    "libopenvino_onnx_frontend.so.2641",
    "libopenvino_ir_frontend.so.2641",
    "libopenvino_intel_cpu_plugin.so",
    "libopenvino_intel_gpu_plugin.so",
    "libopenvino_intel_npu_plugin.so",
    "libtbb.so.12",
    "libhwloc.so.15",
]
notices = [
    "LICENSE",
    "licensing/runtime-third-party-programs.txt",
    "licensing/onetbb_third-party-programs.txt",
    "licensing/onednn_third-party-programs.txt",
]
libs = "openvino/libs/"
licenses = "openvino-2026.4.1.dist-info/licenses/"


def extract(archive, member, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    with archive.open(member) as source, target.open("wb") as sink:
        shutil.copyfileobj(source, sink)
    target.chmod(0o644)


with zipfile.ZipFile(wheel) as archive:
    names = set(archive.namelist())
    for library in required:
        if libs + library not in names:
            sys.exit("missing OpenVINO 2026.4.1 wheel library: " + library)
        extract(archive, libs + library, out / library)
    for name in sorted(names):
        base = name[len(libs):] if name.startswith(libs) else ""
        if base and "/" not in base and (fnmatch.fnmatch(base, "libtbbbind*.so.*") or fnmatch.fnmatch(base, "libtbbmalloc*.so.*")):
            extract(archive, name, out / base)
    for notice in notices:
        if licenses + notice not in names:
            sys.exit("missing OpenVINO notice: " + notice)
        extract(archive, licenses + notice, out / "notices" / notice)
PY
rm -rf "$dest"
mkdir -p "$(dirname "$dest")"
mv "$tmp" "$dest"
chmod 0755 "$dest" "$dest/notices"
echo "staged: OpenVINO 2026.4.1 runtime ($WHEEL_NAME) into $dest"
