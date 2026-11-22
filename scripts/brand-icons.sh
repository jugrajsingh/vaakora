#!/usr/bin/env bash
# Render every Vaakora raster from the SVG masters in brand/ into brand/generated/.
#
#   scripts/brand-icons.sh           write brand/generated/*.png
#   scripts/brand-icons.sh --sync-app  write brand/generated, then copy the app icons into
#                                    src-tauri/icons: the five rasters from brand/generated, and
#                                    icon.ico, icon.icns and the Windows Square/Store logos from
#                                    `tauri icon` run on app-1024.png into target/brand-app-icons
#   scripts/brand-icons.sh --sync-tray write brand/generated, then copy the tray rasters into
#                                    src-tauri/resources under the names tray.rs loads
#   scripts/brand-icons.sh --check   render into target/brand-check and cmp every file
#                                    with brand/generated, and the five src-tauri/icons rasters
#                                    and the src-tauri/resources tray rasters with their
#                                    brand/generated sources, and read seven pixels of the
#                                    Transcribing tray raster (outline, tile, corner); exit 1
#                                    on any difference
#
# Needs ImageMagick with the RSVG delegate (`magick -list format | grep SVG`).
# The density is 96 x scale, so one SVG user unit is one pixel at scale 1. Every
# PNG is 8-bit RGBA (the shape Tauri's icon loader requires).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARK="$ROOT/brand/mark"
TRAY="$ROOT/brand/tray"
GENERATED="$ROOT/brand/generated"

# Tray glyph colours (plan "Tray"): light glyph on a dark panel, dark glyph on a
# light panel; Recording tints only the cursor; the warning badge takes the
# theme's warning colour (brand.json theme.warning).
DARK_GLYPH="#f1f1ef"
LIGHT_GLYPH="#1b1b1b"
DARK_REC_CURSOR="#a9e1b4"
LIGHT_REC_CURSOR="#376b43"
DARK_WARN="#fbbf24"
LIGHT_WARN="#9d5604"
# Colored theme (the app tile; Linux): the 16 app master's own tile, bars and
# cursor colours (brand.json mark). Recording lights the tile in the cursor's
# mint with a forest glyph; Transcribing turns the tile pale with a forest glyph
# and a thin forest outline (one 16-grid unit wide, drawn inside the tile), so
# the pale tile still reads on a light panel and the panel shows each state with
# the same silhouette.
MARK_TILE="#2d583a"
MARK_BARS="#f1f6f2"
MARK_CURSOR="#a9e1b4"

mode="write"
sync_app=0
sync_tray=0
case "${1:-}" in
  "") ;;
  --check) mode="check" ;;
  --sync-app) sync_app=1 ;;
  --sync-tray) sync_tray=1 ;;
  *)
    echo "usage: scripts/brand-icons.sh [--check|--sync-app|--sync-tray]" >&2
    exit 2
    ;;
esac
if [[ $# -gt 1 ]]; then
  echo "usage: scripts/brand-icons.sh [--check|--sync-app|--sync-tray]" >&2
  exit 2
fi

# The raster app icons Tauri bundles, from brand/generated: <icons file> <generated file>.
ICONS="$ROOT/src-tauri/icons"
APP_RASTERS=(
  "32x32.png app-32.png"
  "64x64.png app-64.png"
  "128x128.png app-128.png"
  "128x128@2x.png app-256.png"
  "icon.png app-512.png"
)
# The tray rasters tray.rs loads, from brand/generated: <resources file> <generated file>.
# Dark theme (light panel glyph off) uses the dark-panel files; Light theme the light-panel ones.
RESOURCES="$ROOT/src-tauri/resources"
TRAY_RASTERS=(
  "tray_idle.png tray-dark-panel.png"
  "tray_idle_dark.png tray-light-panel.png"
  "tray_recording.png tray-dark-panel-recording.png"
  "tray_recording_dark.png tray-light-panel-recording.png"
  "tray_idle_warning.png tray-dark-panel-warning.png"
  "tray_idle_warning_dark.png tray-light-panel-warning.png"
  "tray_colored.png tray-colored.png"
  "tray_colored_warning.png tray-colored-warning.png"
  "tray_colored_recording.png tray-colored-recording.png"
  "tray_colored_transcribing.png tray-colored-transcribing.png"
)

if ! magick -list format | grep -q 'SVG.*RSVG'; then
  echo "refusing: ImageMagick has no RSVG delegate" >&2
  exit 1
fi

if [[ "$mode" == check ]]; then
  OUT="$ROOT/target/brand-check"
else
  OUT="$GENERATED"
fi
WORK="$ROOT/target/brand-icons-work"
rm -rf "$WORK"
mkdir -p "$WORK" "$OUT"
if [[ "$mode" == check ]]; then
  rm -rf "$OUT"
  mkdir -p "$OUT"
fi
trap 'rm -rf "$WORK"' EXIT

# render <svg> <viewbox size> <pixel size> <out png>
render() {
  local density
  density="$(awk -v px="$3" -v vb="$2" 'BEGIN { printf "%.6g", 96 * px / vb }')"
  magick -background none -density "$density" "$1" \
    -depth 8 -define png:color-type=6 -define png:exclude-chunks=date,time "$4"
}

# app icons: 16 and 32 use the 16 master (32 is exactly 2x), 22 and 24 have
# fitted masters, 48 and up use the large master.
render "$MARK/vaakora-16.svg" 16 16 "$OUT/app-16.png"
render "$MARK/vaakora-22.svg" 22 22 "$OUT/app-22.png"
render "$MARK/vaakora-24.svg" 24 24 "$OUT/app-24.png"
render "$MARK/vaakora-16.svg" 16 32 "$OUT/app-32.png"
for px in 48 64 128 256 512 1024; do
  render "$MARK/vaakora-large.svg" 1024 "$px" "$OUT/app-$px.png"
done

# tray: the 16 tray master (bars, then cursor, both currentColor) at 4x = 64x64.
# tray_svg <bars colour> <cursor colour> <out svg>
tray_svg() {
  sed "s/currentColor/$1/;s/currentColor/$2/" "$TRAY/tray-16.svg" > "$3"
}
tray_png() {
  render "$1" 16 64 "$2"
}
# warning badge: a 3x3 dot on whole pixels of the 16 grid at (<col>, <row>), at 4x.
# The positions leave a 1 px clear gap to the glyph, so the badge never touches it.
# badge <png> <colour> <col> <row>
badge() {
  local x0=$(($3 * 4)) y0=$(($4 * 4))
  magick "$1" -fill "$2" +antialias \
    -draw "rectangle $x0,$y0 $((x0 + 11)),$((y0 + 11))" \
    -depth 8 -define png:color-type=6 -define png:exclude-chunks=date,time "$1"
}

tray_svg "$DARK_GLYPH" "$DARK_GLYPH" "$WORK/dark.svg"
tray_png "$WORK/dark.svg" "$OUT/tray-dark-panel.png"
tray_svg "$LIGHT_GLYPH" "$LIGHT_GLYPH" "$WORK/light.svg"
tray_png "$WORK/light.svg" "$OUT/tray-light-panel.png"
tray_svg "$DARK_GLYPH" "$DARK_REC_CURSOR" "$WORK/dark-rec.svg"
tray_png "$WORK/dark-rec.svg" "$OUT/tray-dark-panel-recording.png"
tray_svg "$LIGHT_GLYPH" "$LIGHT_REC_CURSOR" "$WORK/light-rec.svg"
tray_png "$WORK/light-rec.svg" "$OUT/tray-light-panel-recording.png"
# Colored theme: the app tile (16 master); Recording and Transcribing recolour it.
# colored_svg <tile> <bars> <cursor> <out svg>
colored_svg() {
  sed "s/fill=\"$MARK_TILE\"/fill=\"TILE\"/;s/fill=\"$MARK_BARS\"/fill=\"BARS\"/;s/fill=\"$MARK_CURSOR\"/fill=\"CURSOR\"/" \
    "$MARK/vaakora-16.svg" | sed "s/fill=\"TILE\"/fill=\"$1\"/;s/fill=\"BARS\"/fill=\"$2\"/;s/fill=\"CURSOR\"/fill=\"$3\"/" > "$4"
}
tray_png "$MARK/vaakora-16.svg" "$OUT/tray-colored.png"
colored_svg "$MARK_CURSOR" "$MARK_TILE" "$MARK_TILE" "$WORK/colored-rec.svg"
tray_png "$WORK/colored-rec.svg" "$OUT/tray-colored-recording.png"
colored_svg "$MARK_BARS" "$MARK_TILE" "$MARK_TILE" "$WORK/colored-busy.svg"
sed -i "s|</svg>|<rect x=\"0.5\" y=\"0.5\" width=\"15\" height=\"15\" rx=\"3\" fill=\"none\" stroke=\"$MARK_TILE\" stroke-width=\"1\"/></svg>|" "$WORK/colored-busy.svg"
tray_png "$WORK/colored-busy.svg" "$OUT/tray-colored-transcribing.png"

cp "$OUT/tray-dark-panel.png" "$OUT/tray-dark-panel-warning.png"
badge "$OUT/tray-dark-panel-warning.png" "$DARK_WARN" 0 13
cp "$OUT/tray-light-panel.png" "$OUT/tray-light-panel-warning.png"
badge "$OUT/tray-light-panel-warning.png" "$LIGHT_WARN" 0 13
cp "$OUT/tray-colored.png" "$OUT/tray-colored-warning.png"
badge "$OUT/tray-colored-warning.png" "$DARK_WARN" 1 12

if [[ "$mode" == check ]]; then
  bad=0
  for pair in "${APP_RASTERS[@]}"; do
    read -r icon generated <<<"$pair"
    if ! cmp -s "$ICONS/$icon" "$GENERATED/$generated"; then
      echo "DIFFERS src-tauri/icons/$icon from brand/generated/$generated"
      bad=1
    fi
  done
  for pair in "${TRAY_RASTERS[@]}"; do
    read -r resource generated <<<"$pair"
    if ! cmp -s "$RESOURCES/$resource" "$GENERATED/$generated"; then
      echo "DIFFERS src-tauri/resources/$resource from brand/generated/$generated"
      bad=1
    fi
  done
  for f in "$OUT"/*.png; do
    name="$(basename "$f")"
    if [[ ! -f "$GENERATED/$name" ]]; then
      echo "MISSING brand/generated/$name"
      bad=1
    elif ! cmp -s "$f" "$GENERATED/$name"; then
      echo "DIFFERS brand/generated/$name"
      bad=1
    fi
  done
  # The Transcribing tray icon keeps its thin outline: forest on the four edges
  # (one 16-grid unit = 4 px wide), pale tile inside, transparent outside the
  # rounded corner. Pixels are read back with ImageMagick as RRGGBBAA.
  transcribing="$GENERATED/tray-colored-transcribing.png"
  forest="${MARK_TILE#\#}FF"
  pale="${MARK_BARS#\#}FF"
  while read -r label x y want; do
    got="$(magick "$transcribing" -format "%[hex:p{$x,$y}]" info: 2>&1)" || got="magick failed: $got"
    want="$(tr '[:lower:]' '[:upper:]' <<<"${want}")"
    if [[ "$got" != "$want" ]]; then
      echo "PIXEL brand/generated/tray-colored-transcribing.png $label ($x,$y) is $got, want $want"
      bad=1
    fi
  done <<EOF_PIXELS
left-outline 1 32 ${forest}
right-outline 62 32 ${forest}
top-outline 32 1 ${forest}
bottom-outline 32 62 ${forest}
tile-inside-outline 5 32 ${pale}
tile-centre 32 32 ${pale}
corner-outside-tile 0 0 00000000
EOF_PIXELS
  if [[ "$bad" -ne 0 ]]; then
    exit 1
  fi
  rm -rf "$OUT"
  echo "brand icons: no difference"
else
  echo "rendered $(find "$OUT" -maxdepth 1 -name '*.png' | wc -l) PNGs into brand/generated"
fi

if [[ "$sync_app" -eq 1 ]]; then
  for pair in "${APP_RASTERS[@]}"; do
    read -r icon generated <<<"$pair"
    cp "$GENERATED/$generated" "$ICONS/$icon"
  done
  # icon.ico, icon.icns and the Windows logos are built by `tauri icon` from the
  # 1024 px raster; only those files are taken from its output.
  TAURI_OUT="$ROOT/target/brand-app-icons"
  rm -rf "$TAURI_OUT"
  mkdir -p "$TAURI_OUT"
  (cd "$ROOT" && bunx tauri icon "$GENERATED/app-1024.png" -o "$TAURI_OUT")
  for f in icon.ico icon.icns StoreLogo.png "$TAURI_OUT"/Square*Logo.png; do
    cp "$TAURI_OUT/$(basename "$f")" "$ICONS/$(basename "$f")"
  done
  rm -rf "$TAURI_OUT"
  echo "synced app icons into src-tauri/icons"
fi

if [[ "$sync_tray" -eq 1 ]]; then
  for pair in "${TRAY_RASTERS[@]}"; do
    read -r resource generated <<<"$pair"
    cp "$GENERATED/$generated" "$RESOURCES/$resource"
  done
  echo "synced ${#TRAY_RASTERS[@]} tray rasters into src-tauri/resources"
fi
