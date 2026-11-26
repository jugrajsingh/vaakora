#!/usr/bin/env bash
# Repack the payload of Vaakora's .deb as an Arch package with makepkg, inside rootless podman and offline.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE=vaakora-build:arch

usage() {
  echo 'usage: arch-package.sh ABSOLUTE_DEB OUT_DIR' >&2
  exit 2
}

if [[ $# -ne 2 || "$1" != /* || ! -f "$1" ]]; then
  usage
fi
deb=$1
out=$2
name=$(basename "$deb")
if [[ ! "$name" =~ ^Vaakora_([0-9]+\.[0-9]+\.[0-9]+)_amd64\.deb$ ]]; then
  echo "refusing: $name is not Vaakora_<version>_amd64.deb" >&2
  exit 2
fi
version=${BASH_REMATCH[1]}
sha=$(sha256sum "$deb" | cut -d' ' -f1)

context=$HERE/.work/arch-image-context
rm -rf "$context"
mkdir -p "$context"
podman build -f "$HERE/arch/Containerfile" -t "$IMAGE" "$context"

# makepkg verifies the copied deb against this sha256 before it unpacks anything.
build=$HERE/.work/arch-build
rm -rf "$build"
mkdir -p "$build"
sed -e "s/^pkgver=.*/pkgver=$version/" -e "s/^sha256sums=.*/sha256sums=('$sha')/" "$HERE/arch/PKGBUILD" >"$build/PKGBUILD"
cp "$deb" "$build/"
podman run --rm --network=none --userns=keep-id -v "$build:/pkg:z" "$IMAGE" makepkg --nodeps --noconfirm

package=vaakora-$version-1-x86_64.pkg.tar.zst
mkdir -p "$out"
cp "$build/$package" "$out/"
echo "built: $(cd "$out" && pwd)/$package"
