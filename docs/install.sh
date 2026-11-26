#!/bin/sh
# Vaakora one-line installer for Linux x86_64.
#
#   curl -fsSL https://vaakora.jugraj.dev/install.sh | sh
#   wget -qO- https://vaakora.jugraj.dev/install.sh | sh
#
# Installs or upgrades Vaakora with the system package manager (dnf, apt or
# pacman); every other distribution gets the AppImage in ~/.local/bin.
# Pass --appimage (sh -s -- --appimage when piped) to force the AppImage.
#
# Environment:
#   VAAKORA_VERSION      install this release (for example 0.4.0) instead of the latest
#   VAAKORA_RELEASE_URL  download SHA256SUMS and the package from this base URL
#                        instead of GitHub Releases (mirrors, tests)
#   VAAKORA_OS_RELEASE   os-release file to read; defaults to /etc/os-release
#                        (test hook, not for users)
#
# Every statement lives inside main, and main is called on the last line, so a
# download that stops part-way is a syntax error and does nothing.
set -eu

main() {
  repo_url="https://github.com/jugrajsingh/vaakora"
  tmp=""

  say() { printf '%s\n' "$*"; }
  warn() { printf 'vaakora: warning: %s\n' "$*" >&2; }
  die() {
    printf 'vaakora: %s\n' "$*" >&2
    exit 1
  }
  have() { command -v "$1" >/dev/null 2>&1; }
  cleanup() {
    if [ -n "$tmp" ]; then
      rm -rf "$tmp"
    fi
  }
  fetch() {
    if [ "$downloader" = curl ]; then
      curl -fsSL "$1" -o "$2"
    else
      wget -qO "$2" "$1"
    fi
  }
  # run_pm <non-interactive flag> <command and arguments>: print the command,
  # then run it. With a terminal the package manager prompts on /dev/tty (stdin
  # is the script when piped); without one it gets the flag and no stdin.
  run_pm() {
    flag=$1
    shift
    if (: </dev/tty) 2>/dev/null; then
      interactive=1
    else
      interactive=0
      set -- "$@" "$flag"
    fi
    if [ -n "$sudo_cmd" ]; then
      set -- sudo "$@"
    fi
    say "Running: $*"
    if [ "$interactive" = 1 ]; then
      "$@" </dev/tty
    else
      "$@" </dev/null
    fi
  }

  force_appimage=0
  for arg in "$@"; do
    case $arg in
      --appimage) force_appimage=1 ;;
      *) die "unknown option: $arg (usage: sh install.sh [--appimage])" ;;
    esac
  done

  # Platform.
  os=$(uname -s) || die "cannot run uname"
  arch=$(uname -m) || die "cannot run uname"
  [ "$os" = Linux ] || die "$os is not supported yet: Windows and macOS builds are coming soon. See $repo_url#install"
  case $arch in
    x86_64 | amd64) ;;
    *) die "only x86_64 is supported, found $arch. See $repo_url#install" ;;
  esac

  # glibc 2.35 or newer.
  glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | sed -n 's/^glibc \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')
  if [ -z "$glibc" ]; then
    glibc=$(ldd --version 2>&1 | head -n 1 | sed -n 's/.* \([0-9][0-9]*\.[0-9][0-9]*\)$/\1/p')
  fi
  [ -n "$glibc" ] || die "could not detect glibc, and Vaakora needs glibc 2.35 or newer"
  glibc_major=${glibc%%.*}
  glibc_minor=${glibc#*.}
  if [ "$glibc_major" -lt 2 ] || { [ "$glibc_major" -eq 2 ] && [ "$glibc_minor" -lt 35 ]; }; then
    die "glibc $glibc is too old: Vaakora needs glibc 2.35 or newer"
  fi

  # Package kind from os-release: ID first, then each word of ID_LIKE.
  os_release=${VAAKORA_OS_RELEASE:-/etc/os-release}
  os_id=""
  os_like=""
  if [ -r "$os_release" ]; then
    os_id=$(sed -n 's/^ID=//p' "$os_release" | head -n 1 | tr -d "\"'" | tr '[:upper:]' '[:lower:]')
    os_like=$(sed -n 's/^ID_LIKE=//p' "$os_release" | head -n 1 | tr -d "\"'" | tr '[:upper:]' '[:lower:]')
  fi
  kind=appimage
  if [ "$force_appimage" = 0 ]; then
    for word in $os_id $os_like; do
      case $word in
        fedora | rhel | centos)
          if have dnf; then kind=rpm; fi
          break
          ;;
        debian | ubuntu)
          kind=deb
          break
          ;;
        arch)
          kind=arch
          break
          ;;
      esac
    done
  fi

  # Privilege: system packages need root or sudo.
  sudo_cmd=""
  uid=$(id -u) || die "cannot run id"
  if [ "$kind" != appimage ] && [ "$uid" != 0 ]; then
    have sudo || die "needs sudo (or a root shell) to install a system package; install sudo, or add --appimage to install into ~/.local/bin"
    sudo_cmd=sudo
  fi

  # Downloader and checksum tool.
  if have curl; then
    downloader=curl
  elif have wget; then
    downloader=wget
  else
    die "needs curl or wget"
  fi
  have sha256sum || die "needs sha256sum"

  # Temporary directory, readable by apt's _apt user, removed on every exit.
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/vaakora.XXXXXX") || die "cannot create a temporary directory"
  chmod 755 "$tmp"

  if [ -n "${VAAKORA_RELEASE_URL:-}" ]; then
    base=${VAAKORA_RELEASE_URL%/}
  elif [ -n "${VAAKORA_VERSION:-}" ]; then
    base="$repo_url/releases/download/v$VAAKORA_VERSION"
  else
    base="$repo_url/releases/latest/download"
  fi

  # The package name and its checksum come from SHA256SUMS.
  say "Downloading the Vaakora checksums from $base"
  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "could not download $base/SHA256SUMS"
  case $kind in
    rpm) pattern='\.x86_64\.rpm$' ;;
    deb) pattern='_amd64\.deb$' ;;
    arch) pattern='-x86_64\.pkg\.tar\.zst$' ;;
    appimage) pattern='_amd64\.AppImage$' ;;
  esac
  entry=$(grep -E -e "$pattern" "$tmp/SHA256SUMS" || true)
  [ -n "$entry" ] || die "SHA256SUMS lists no $kind package"
  [ "$(printf '%s\n' "$entry" | wc -l)" -eq 1 ] || die "SHA256SUMS lists more than one $kind package"
  sum=${entry%% *}
  file=$(printf '%s\n' "$entry" | sed 's/^[^ ]*  *\*\{0,1\}//')
  case $file in
    "" | */* | .*) die "SHA256SUMS has an unusable file name: $file" ;;
  esac

  say "Downloading $file"
  fetch "$base/$file" "$tmp/$file" || die "could not download $base/$file"
  printf '%s  %s\n' "$sum" "$file" >"$tmp/$file.sha256"
  if ! (cd "$tmp" && sha256sum -c "$file.sha256" >/dev/null 2>&1); then
    die "checksum mismatch for $file; refusing to install it"
  fi
  say "Checksum verified"
  chmod 644 "$tmp/$file"
  pkg="$tmp/$file"

  if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -z "${DISPLAY:-}" ]; then
    warn "no graphical session found. Vaakora is a desktop app, so you need a desktop login to start it. Installing anyway."
  fi

  case $kind in
    rpm)
      run_pm -y dnf install "$pkg" || die "dnf could not install $file"
      remove="sudo dnf remove vaakora"
      ;;
    deb)
      run_pm -y apt install "$pkg" || die "apt could not install $file"
      remove="sudo apt remove vaakora"
      ;;
    arch)
      run_pm --noconfirm pacman -U "$pkg" || die "pacman could not install $file"
      remove="sudo pacman -R vaakora"
      ;;
    appimage)
      [ -n "${HOME:-}" ] || die "HOME is not set"
      bin_dir="$HOME/.local/bin"
      mkdir -p "$bin_dir" || die "cannot create $bin_dir"
      # Install beside the target and rename, so a running Vaakora does not block an upgrade.
      if ! { install -m 0755 "$pkg" "$bin_dir/vaakora.new" && mv -f "$bin_dir/vaakora.new" "$bin_dir/vaakora"; }; then
        die "cannot install $bin_dir/vaakora"
      fi
      case ":${PATH:-}:" in
        *":$bin_dir:"*) ;;
        *) say "Note: ~/.local/bin is not on your PATH. Add it with: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
      esac
      ldconfig_cmd=$(command -v ldconfig || true)
      [ -n "$ldconfig_cmd" ] || ldconfig_cmd=/sbin/ldconfig
      if [ -x "$ldconfig_cmd" ] && ! "$ldconfig_cmd" -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
        say "The AppImage needs FUSE 2 (libfuse2), which is not installed. Install it, or start Vaakora with: vaakora --appimage-extract-and-run"
      fi
      remove="rm ~/.local/bin/vaakora"
      ;;
  esac

  say "To remove it later: $remove"
  say "Vaakora is installed. Start it from your apps menu, or run: vaakora"
}

main "$@"
