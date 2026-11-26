#!/usr/bin/env bash
# Installs each package in a clean distro container (rootless podman) and runs install-smoke.sh there, one target after another.
set -euo pipefail

usage() {
  echo "usage: $0 DIST_DIR VERSION [TARGET...]" >&2
  exit 2
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# name image kind
MATRIX=(
  "fedora-44 registry.fedoraproject.org/fedora:44 rpm"
  "fedora-45 registry.fedoraproject.org/fedora:45 rpm"
  "debian-12 docker.io/library/debian:12 deb"
  "debian-13 docker.io/library/debian:13 deb"
  "ubuntu-22.04 docker.io/library/ubuntu:22.04 deb"
  "ubuntu-24.04 docker.io/library/ubuntu:24.04 deb"
  "ubuntu-26.04 docker.io/library/ubuntu:26.04 deb"
  "ubuntu-26.10 docker.io/library/ubuntu:26.10 deb"
  "arch docker.io/library/archlinux:latest arch"
  "appimage-fedora-45 registry.fedoraproject.org/fedora:45 appimage"
  "appimage-debian-12 docker.io/library/debian:12 appimage"
  "appimage-ubuntu-22.04 docker.io/library/ubuntu:22.04 appimage"
  "appimage-arch docker.io/library/archlinux:latest appimage"
)

[[ $# -ge 2 && -d "$1" && -n "$2" ]] || usage
dist="$(cd "$1" && pwd)"
version="$2"
shift 2

package_file() {
  case "$1" in
    rpm) echo "Vaakora-$version-1.x86_64.rpm" ;;
    deb) echo "Vaakora_${version}_amd64.deb" ;;
    arch) echo "vaakora-$version-1-x86_64.pkg.tar.zst" ;;
    appimage) echo "Vaakora_${version}_amd64.AppImage" ;;
  esac
}

selected=()
if [[ $# -eq 0 ]]; then
  selected=("${MATRIX[@]}")
fi
for want in "$@"; do
  found=
  for row in "${MATRIX[@]}"; do
    if [[ "${row%% *}" == "$want" ]]; then
      found="$row"
    fi
  done
  if [[ -z "$found" ]]; then
    echo "unknown target: $want" >&2
    usage
  fi
  selected+=("$found")
done

# Every package the selected targets need must be present before the first container starts.
missing=0
for row in "${selected[@]}"; do
  read -r _ _ kind <<<"$row"
  file="$dist/$(package_file "$kind")"
  if [[ ! -f "$file" ]]; then
    echo "missing: $file" >&2
    missing=1
  fi
done
if [[ "$missing" -ne 0 ]]; then
  usage
fi

logs="$HERE/.work/logs/install-test-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$logs"
echo "logs: $logs"

# Only the dist dir and the smoke script are mounted, both read-only. No --cgroups=split and no systemd-run: under
# pueue, split containers fail with "crun: controller 'pids' is not available", and these containers need no memory cap.
failed=0
for row in "${selected[@]}"; do
  read -r name image kind <<<"$row"
  log="$logs/$name.log"
  digest=unknown
  if podman pull -q "$image" >"$log" 2>&1 &&
    digest="$(podman image inspect --format '{{.Digest}}' "$image" 2>>"$log")" &&
    podman run --rm --timeout 1800 \
      -v "$dist:/dist:ro,z" \
      -v "$HERE/install-smoke.sh:/smoke.sh:ro,z" \
      "$image" bash /smoke.sh "$kind" "/dist/$(package_file "$kind")" >>"$log" 2>&1; then
    echo "PASS $name $image@$digest"
  else
    echo "FAIL $name $image@${digest:-unknown} (log: $log)"
    failed=1
  fi
done
exit "$failed"
