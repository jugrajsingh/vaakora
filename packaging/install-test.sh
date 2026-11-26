#!/usr/bin/env bash
# Installs each package in a clean distro container (rootless podman) and runs install-smoke.sh there, one target after
# another. With --script the install is done by the one-line installer, docs/install.sh, from a local release dir.
set -euo pipefail

usage() {
  echo "usage: $0 [--script] DIST_DIR VERSION [TARGET...]" >&2
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

script=0
if [[ "${1:-}" == --script ]]; then
  script=1
  shift
fi
[[ $# -ge 2 && -d "$1" && -n "$2" ]] || usage
dist="$(cd "$1" && pwd)"
repo="$(cd "$HERE/.." && pwd)"
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

# Every package the selected targets need must be present before the first container starts. The release dir of --script
# holds all four packages, so then all four are needed.
missing=0
needed=()
if [[ "$script" -eq 1 ]]; then
  needed=(rpm deb arch appimage)
else
  for row in "${selected[@]}"; do
    read -r _ _ kind <<<"$row"
    needed+=("$kind")
  done
fi
for kind in "${needed[@]}"; do
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

# What the container runs in --script mode (bash -c, one line per step, joined with ";"; $1 is the target's package kind,
# the rest go to the installer). A clean Debian or Ubuntu image has no curl, so the prerequisites come first. The installer
# then runs twice: the second run is the rerun on an installed system and must exit 0. Last, the smoke checks what the
# installer put there. The installer runs under sh (dash on Debian and Ubuntu), the only dash coverage it gets.
# shellcheck disable=SC2016 # the steps are code for the container's shell: $1, $ID and $* must stay unexpanded here
script_steps=(
  'set -eu'
  'kind=$1'
  'shift'
  '. /etc/os-release'
  'case $ID in '\
'fedora) command -v curl >/dev/null || dnf install -y curl; dnf install -y ca-certificates ;; '\
'debian | ubuntu) apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates ;; '\
'arch) pacman -Syu --noconfirm --needed curl ca-certificates ;; '\
'*) echo "no prerequisites recipe for ID=$ID" >&2; exit 1 ;; '\
'esac'
  'echo "== sh /install.sh $*"'
  'sh /install.sh "$@"'
  'echo "== rerun on the installed system: sh /install.sh $*"'
  'sh /install.sh "$@"'
  'if [ "$kind" = appimage ]; then bash /smoke.sh --installed appimage /root/.local/bin/vaakora; else bash /smoke.sh --installed "$kind"; fi'
)
script_body="$(IFS=';'; echo "${script_steps[*]}")"

release="$logs/release"
if [[ "$script" -eq 1 ]]; then
  # In this run's logs dir: a copy, never a link, of exactly the four VERSION files, with a SHA256SUMS over their bare names.
  mkdir "$release"
  for kind in rpm deb arch appimage; do
    cp --reflink=auto "$dist/$(package_file "$kind")" "$release/"
    (cd "$release" && sha256sum "$(package_file "$kind")") >>"$release/SHA256SUMS"
  done
fi

# Only the dist dir (or, with --script, the release dir and the installer) and the smoke script are mounted, all
# read-only. No --cgroups=split and no systemd-run: under pueue, split containers fail with
# "crun: controller 'pids' is not available", and these containers need no memory cap.
failed=0
for row in "${selected[@]}"; do
  read -r name image kind <<<"$row"
  log="$logs/$name.log"
  digest=unknown
  if [[ "$script" -eq 1 ]]; then
    flag=()
    if [[ "$kind" == appimage ]]; then
      flag=(--appimage)
    fi
    run=(
      -v "$release:/dist:ro,z"
      -v "$repo/docs/install.sh:/install.sh:ro,z"
      -v "$HERE/install-smoke.sh:/smoke.sh:ro,z"
      -e VAAKORA_RELEASE_URL=file:///dist
      "$image" bash -c "$script_body" install "$kind" "${flag[@]}"
    )
  else
    run=(
      -v "$dist:/dist:ro,z"
      -v "$HERE/install-smoke.sh:/smoke.sh:ro,z"
      "$image" bash /smoke.sh "$kind" "/dist/$(package_file "$kind")"
    )
  fi
  if podman pull -q "$image" >"$log" 2>&1 &&
    digest="$(podman image inspect --format '{{.Digest}}' "$image" 2>>"$log")" &&
    podman run --rm --timeout 1800 "${run[@]}" >>"$log" 2>&1; then
    echo "PASS $name $image@$digest"
  else
    echo "FAIL $name $image@${digest:-unknown} (log: $log)"
    failed=1
  fi
done
exit "$failed"
