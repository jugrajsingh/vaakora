#!/usr/bin/env bash
# Install the RPM built by build.sh into packaging/dist. Run by the user: it calls sudo dnf.
set -euo pipefail

dry_run=0
case "${1:-}" in
  "") ;;
  --dry-run) dry_run=1 ;;
  *)
    echo "usage: $0 [--dry-run]" >&2
    exit 2
    ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
source "$HERE/lib.sh"
name="$(sed -n '/^\[package\]/,/^\[/{s/^name = "\(.*\)"/\1/p}' "$REPO/src-tauri/Cargo.toml" | head -1)"
if [[ -z "$name" ]]; then
  echo "refusing: no [package] name in $REPO/src-tauri/Cargo.toml" >&2
  exit 1
fi
want="$(jq -er .version "$REPO/src-tauri/tauri.conf.json")"

rpm="$(select_rpm "$HERE/dist" "$name" "$want" || true)"
if [[ -z "$rpm" ]]; then
  echo "refusing: no packaging/dist RPM named $name with version $want; run packaging/build.sh first" >&2
  exit 1
fi

have=""
if rpm -q "$name" >/dev/null 2>&1; then
  have="$(rpm -q --qf '%{VERSION}' "$name")"
fi

if [[ -z "$have" ]]; then
  action=install
elif [[ "$have" == "$want" ]]; then
  action=reinstall
elif [[ "$(printf '%s\n%s\n' "$have" "$want" | sort -V | tail -1)" == "$want" ]]; then
  action=upgrade
else
  action=downgrade
fi

echo "rpm: $rpm (want $want, installed ${have:-none}) -> $action"
# The local RPM is unsigned, so dnf must be told to skip the GPG check.
cmd=(sudo dnf "$action" --nogpgcheck -y "$rpm")

if [[ "$dry_run" -eq 1 ]]; then
  printf 'dry-run: would run'
  printf ' %q' "${cmd[@]}"
  echo
  exit 0
fi

"${cmd[@]}"

echo "done. Quit the app from the tray and relaunch it (or re-login)."
