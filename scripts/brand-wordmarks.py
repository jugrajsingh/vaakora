"""Outline the Vaakora wordmarks from the pinned Anek fonts.

Run (from the repository root):

    uv run --no-project --with fonttools==4.68.0 --with uharfbuzz==0.57.0 \
        python -I scripts/brand-wordmarks.py [--check]

Each Anek variable font is instantiated at wght 600, wdth 100, the word is
shaped with HarfBuzz (the font's own kerning and mark positioning) and every
glyph is drawn with fontTools' SVGPathPen at its shaped position, so the app
ships outlines and no font. Writes brand/wordmark/vaakora-{latin,pa,hi}.svg
(fill currentColor) and brand/generated/wordmark-latin.json. With --check it
writes nothing and exits 1 naming every file that differs.

The fonts are SIL OFL 1.1; brand/fonts/OFL.txt is their licence and applies
to the outlines too.
"""

import io
import json
import sys
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parent.parent
LOCATION = {"wght": 600, "wdth": 100}

# (output name, font file, text)
WORDS = [
    ("latin", "AnekLatin[wdth,wght].ttf", "Vaakora"),
    ("pa", "AnekGurmukhi[wdth,wght].ttf", "ਵਾਕੋਰਾ"),
    ("hi", "AnekDevanagari[wdth,wght].ttf", "वाकोरा"),
]


def num(value: float) -> str:
    """Two decimals, no trailing zeros, no negative zero."""
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def outline(font_file: str, text: str) -> dict:
    """Shape `text` in one font instance; paths are y-down, baseline at y=0."""
    font = TTFont(ROOT / "brand" / "fonts" / font_file)
    font = instantiateVariableFont(font, LOCATION)
    glyph_set = font.getGlyphSet()
    order = font.getGlyphOrder()
    upm = font["head"].unitsPerEm

    blob = io.BytesIO()
    font.save(blob)
    face = hb.Face(blob.getvalue())
    hb_font = hb.Font(face)
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(hb_font, buf)

    paths = []
    x = 0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        pen = SVGPathPen(glyph_set, ntos=num)
        glyph_set[order[info.codepoint]].draw(
            TransformPen(pen, (1, 0, 0, -1, x + pos.x_offset, -pos.y_offset))
        )
        d = pen.getCommands()
        if d:
            paths.append(d)
        x += pos.x_advance

    ascent, descent = font["hhea"].ascent, font["hhea"].descent
    cap = getattr(font["OS/2"], "sCapHeight", 0)
    return {
        "upm": upm,
        "cap": cap,
        "width": x,
        "viewBox": f"0 {-ascent} {x} {ascent - descent}",
        "paths": paths,
    }


def render() -> dict[Path, str]:
    """Every output file as {path: text}."""
    files: dict[Path, str] = {}
    for name, font_file, text in WORDS:
        out = outline(font_file, text)
        body = "".join(f'<path d="{d}"/>' for d in out["paths"])
        files[ROOT / "brand" / "wordmark" / f"vaakora-{name}.svg"] = (
            '<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="{out["viewBox"]}"><g fill="currentColor">{body}</g></svg>\n'
        )
        if name == "latin":
            files[ROOT / "brand" / "generated" / "wordmark-latin.json"] = (
                json.dumps(out, indent=2, ensure_ascii=False) + "\n"
            )
    return files


def main(argv: list[str]) -> int:
    check = argv == ["--check"]
    if argv and not check:
        print("usage: brand-wordmarks.py [--check]", file=sys.stderr)
        return 2
    differ = []
    for path, text in render().items():
        if check:
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                differ.append(path)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            print(f"wrote {path.relative_to(ROOT)}")
    if differ:
        for path in differ:
            print(f"DIFFERS {path.relative_to(ROOT)}")
        return 1
    if check:
        print("wordmarks: no difference")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
