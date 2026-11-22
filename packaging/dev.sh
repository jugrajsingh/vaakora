#!/usr/bin/env bash
# Run one command inside the build image against a checkout or worktree.
# Dev loop only (cargo test/clippy/fmt, bun lint/build, bindings export); release builds use build.sh.
set -euo pipefail

usage() {
  echo "usage: $0 [--mount <host-path>:<container-path>]... [--env NAME=VALUE]... [--device /dev/dri/renderD128] [--device /dev/accel/accel0] <worktree> <command> [args...]" >&2
  echo "  runs <command> in /src (the worktree) inside vaakora-build:fedora45; --mount is read-only" >&2
  exit 2
}

extra=()
hardware=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mount)
      [[ $# -ge 2 && "$2" == *:* ]] || usage
      host="${2%%:*}"
      if [[ ! -e "$host" ]]; then
        echo "refusing: mount source $host does not exist" >&2
        exit 2
      fi
      extra+=(-v "$(cd "$(dirname "$host")" && pwd -P)/$(basename "$host"):${2#*:}:ro")
      shift 2
      ;;
    --device)
      [[ $# -ge 2 ]] || usage
      case "$2" in /dev/dri/renderD128|/dev/accel/accel0) ;; *) usage ;; esac
      if [[ ! -c "$2" ]]; then
        echo "refusing: device $2 is not a character device" >&2
        exit 2
      fi
      extra+=(--device "$2")
      hardware=(--group-add keep-groups --security-opt label=disable)
      shift 2
      ;;
    --env)
      [[ $# -ge 2 && "$2" == *=* ]] || usage
      extra+=(-e "$2")
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -*) usage ;;
    *) break ;;
  esac
done

if [[ $# -lt 2 ]]; then
  usage
fi
if [[ ! -d "$1" ]]; then
  echo "refusing: $1 is not a directory" >&2
  exit 2
fi
WT="$(cd "$1" && pwd -P)"
shift
if [[ ! -f "$WT/src-tauri/Cargo.toml" ]]; then
  echo "refusing: $WT has no src-tauri/Cargo.toml (not a checkout of this project)" >&2
  exit 2
fi

IMAGE=vaakora-build:fedora45
if ! podman image exists "$IMAGE"; then
  echo "refusing: image $IMAGE missing; run build.sh once to build it" >&2
  exit 1
fi
# One cargo target volume shared with build.sh (same image); dev builds land in debug/, release builds in release/.
TARGET_VOL=vaakora-target
for vol in vaakora-cargo vaakora-bun "$TARGET_VOL" vaakora-ortcache; do
  podman volume exists "$vol" || podman volume create "$vol" >/dev/null
done

tty_flag=()
if [[ -t 0 && -t 1 ]]; then
  tty_flag=(-t)
fi

# The default podman network stays enabled: cargo and bun download crates and packages.
# --cgroups=split creates the container's cgroup under the caller's, so a `systemd-run --user --scope -p MemoryMax=...`
# around this script caps the container too (rootless podman otherwise starts it in its own libpod scope).
# --timeout makes podman kill the container itself: a caller's `timeout` only kills the podman client, and the container would keep running.
# exec hands podman's exit status (the inner command's status) straight back to the caller.
exec podman run --rm --timeout "${HANDY_DEV_TIMEOUT:-3600}" --userns=keep-id --cgroups=split "${hardware[@]}" "${tty_flag[@]}" \
  -e CARGO_TARGET_DIR=/cache/dev-target \
  -v "$WT:/src:z" \
  -v vaakora-cargo:/cache/cargo:z \
  -v vaakora-bun:/cache/bun:z \
  -v "$TARGET_VOL":/cache/dev-target:z \
  -v vaakora-ortcache:/home/builder/.cache:z \
  "${extra[@]}" \
  -w /src \
  "$IMAGE" "$@"
