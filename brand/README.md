# Brand

The Vaakora brand sources. `brand.json` at the repository root is the single source for names, ids, links, mark colours and theme values; this folder holds the masters and everything rendered from them.

## Files

| Path                                | What it is                                                                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mark/vaakora-{16,22,24,large}.svg` | Voice cursor app mark masters (tile, two bars, a text cursor). 16, 22 and 24 are pixel-fitted masters; `large` is 1024 units.                                           |
| `mark/vaakora-*-dark.svg`           | The same masters plus a 1 unit keyline in `#658b6f`, for dark grounds only.                                                                                             |
| `tray/tray-{16,22,24}.svg`          | One tray silhouette (bars and cursor), `currentColor`, no tile.                                                                                                         |
| `wordmark/vaakora-latin.svg`        | `Vaakora` outlined from Anek Latin (weight 600, width 100), `currentColor`.                                                                                             |
| `wordmark/vaakora-pa.svg`           | `ਵਾਕੋਰਾ` outlined from Anek Gurmukhi (same instance). Brand asset; not shown in the app.                                                                                |
| `wordmark/vaakora-hi.svg`           | `वाकोरा` outlined from Anek Devanagari (same instance). Brand asset; not shown in the app.                                                                              |
| `fonts/Anek*[wdth,wght].ttf`        | The three variable fonts the wordmarks are outlined from, pinned to google/fonts commit `06bfe0d62a98375cb09c942fa18e68bd32cff057`.                                     |
| `fonts/OFL.txt`                     | SIL Open Font License 1.1 for the Anek fonts; it also covers the outlines derived from them. The app ships outlines, no font.                                           |
| `generated/app-<px>.png`            | App icons at 16, 22, 24, 32, 48, 64, 128, 256, 512 and 1024 px (32 is the 16 master at 2x; 48 and up use the large master).                                             |
| `generated/tray-*.png`              | 64x64 tray rasters from the 16 tray master at 4x: dark-panel, light-panel, each `-recording` (cursor tinted), `-colored` (the app tile) and a `-warning` badge variant. |
| `generated/wordmark-latin.json`     | The Latin wordmark as data: `upm`, `cap`, `width`, `viewBox` and one path per glyph (y down, baseline at 0).                                                            |

Every SVG here has a `viewBox` and no `width`, `height` or `filter`. Rects are on whole pixels and the 16 master has square-ended bars.

## Colours

| Role                    | Value                                  |
| ----------------------- | -------------------------------------- |
| Tile                    | `#2d583a`                              |
| Bars                    | `#f1f6f2`                              |
| Cursor                  | `#a9e1b4`                              |
| Dark keyline            | `#658b6f`                              |
| Tray, dark panel glyph  | `#f1f1ef` (recording cursor `#a9e1b4`) |
| Tray, light panel glyph | `#1b1b1b` (recording cursor `#376b43`) |

The theme values (S3 Forest and mint) live in `brand.json` under `theme`.

## Regenerate

```bash
# rasters (ImageMagick with the RSVG delegate); --check renders into target/brand-check and compares
scripts/brand-icons.sh [--check]

# wordmark outlines and wordmark-latin.json (needs network the first time for the pinned wheels)
uv run --no-project --with fonttools==4.68.0 --with uharfbuzz==0.57.0 python -I scripts/brand-wordmarks.py [--check]

# everything above, as a gate
bun scripts/check-brand.ts
```

Edit a master or `brand.json`, regenerate, commit the sources and `generated/` together.
