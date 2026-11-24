//! Table blocks in read-aloud text, found before the text cursor runs.
//!
//! One forward pass reads and classifies every line once. A run of box-drawing lines, or of
//! ASCII `+---+` rules and `|` walls, that holds a rule line and a content line is parsed into a
//! grid by display column. A Markdown (GFM) header line followed by a delimiter row with the
//! same cell count hands the slice up to the next blank line, fence, or box-drawing or ASCII
//! rule line to pulldown-cmark once, and every top-level table of that parse is taken. A
//! candidate that cannot be read as a grid with confidence is a `Fallback` block, read in source
//! order with its borders dropped, so no word is lost. Lines inside a fenced code block are never
//! candidates.

#![cfg_attr(
    not(test),
    expect(dead_code, reason = "wired into TextCursor in Task 2")
)]

use std::ops::Range;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

/// A table candidate: `range` runs from the start of its first line to the end of its last line,
/// line break excluded.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Block<'a> {
    pub range: Range<usize>,
    pub kind: BlockKind<'a>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum BlockKind<'a> {
    Table(Table<'a>),
    /// Not a grid read with confidence: read in source order, borders dropped.
    Fallback,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Table<'a> {
    pub columns: usize,
    pub header: Option<Row<'a>>,
    pub rows: Vec<Row<'a>>,
}

/// `range` runs from the start of the row's first content line to the end of its last one, line
/// break excluded (GFM: the row's event range, line break trimmed); `cells.len() == columns`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Row<'a> {
    pub range: Range<usize>,
    pub cells: Vec<Cell<'a>>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Cell<'a> {
    /// Box or ASCII: the trimmed slice of this column on each content line of the row, top to
    /// bottom; blank slices omitted; empty = empty cell.
    Lines(Vec<Range<usize>>),
    /// GFM: the cell's inline pulldown events with source byte ranges (borrowed from `source`).
    Inline(Vec<(Event<'a>, Range<usize>)>),
}

/// The table blocks of `source`, in source order.
pub(crate) fn find_blocks(source: &str) -> Vec<Block<'_>> {
    scan(source, &mut 0)
}

/// `find_blocks` and the number of bytes it examined, pulldown-cmark's input included.
#[cfg(test)]
pub(crate) fn find_blocks_counted(source: &str) -> (Vec<Block<'_>>, usize) {
    let mut work = 0;
    let blocks = scan(source, &mut work);
    (blocks, work)
}

/// The Markdown options the text cursor parses with, so a cell's inline events match today's.
const MARKDOWN: Options = Options::ENABLE_TABLES
    .union(Options::ENABLE_FOOTNOTES)
    .union(Options::ENABLE_STRIKETHROUGH);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Grid {
    Box,
    Ascii,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Blank,
    BoxRule,
    BoxContent,
    AsciiRule,
    AsciiContent,
    Other,
}

impl Kind {
    fn grid(self) -> Option<Grid> {
        match self {
            Kind::BoxRule | Kind::BoxContent => Some(Grid::Box),
            Kind::AsciiRule | Kind::AsciiContent => Some(Grid::Ascii),
            Kind::Blank | Kind::Other => None,
        }
    }

    fn is_rule(self) -> bool {
        matches!(self, Kind::BoxRule | Kind::AsciiRule)
    }
}

/// A run of three or more backticks or tildes at the start of a line, at most three spaces in.
#[derive(Debug, Clone, Copy)]
struct FenceMark {
    ch: char,
    len: usize,
    /// It can open a fence (a backtick fence's info string holds no backtick).
    opens: bool,
    /// Nothing but whitespace follows the run.
    closes: bool,
}

impl FenceMark {
    fn closes(self, open: FenceMark) -> bool {
        self.closes && self.ch == open.ch && self.len >= open.len
    }
}

#[derive(Debug)]
struct Line {
    start: usize,
    /// End of the line's text, before `\n` and a `\r` preceding it.
    end: usize,
    /// Start of the next line.
    next: usize,
    /// The line without its surrounding whitespace.
    text: Range<usize>,
    kind: Kind,
    fence: Option<FenceMark>,
    /// Cells split by unescaped `|` (outer pipes dropped) when the line could head a GFM table.
    pipe_cells: Option<usize>,
    /// Cells when the line is a GFM delimiter row.
    delimiter_cells: Option<usize>,
}

impl Line {
    /// A GFM slice stops before a blank line, a fence opener, and a box-drawing or ASCII `+---+`
    /// rule line: pulldown would read such a line after a table as one more row, and the line
    /// scan must reach it to find a grid table there. A grid with no top rule that starts inside
    /// the slice keeps its words but loses its header (accepted).
    fn ends_markdown_slice(&self) -> bool {
        matches!(self.kind, Kind::Blank | Kind::BoxRule | Kind::AsciiRule)
            || self.fence.is_some_and(|mark| mark.opens)
    }
}

fn is_box(ch: char) -> bool {
    ('\u{2500}'..='\u{257F}').contains(&ch)
}

fn is_box_wall(ch: char) -> bool {
    matches!(ch, '│' | '┃' | '║')
}

/// Box characters that draw only a horizontal line; any other one is a corner or junction.
fn is_box_horizontal(ch: char) -> bool {
    matches!(
        ch,
        '─' | '━'
            | '┄'
            | '┅'
            | '┈'
            | '┉'
            | '╌'
            | '╍'
            | '═'
            | '╴'
            | '╶'
            | '╸'
            | '╺'
            | '╼'
            | '╾'
    )
}

fn is_wall(ch: char, grid: Grid) -> bool {
    match grid {
        Grid::Box => is_box_wall(ch),
        Grid::Ascii => ch == '|',
    }
}

fn is_junction(ch: char, grid: Grid) -> bool {
    match grid {
        Grid::Box => !is_box_horizontal(ch),
        Grid::Ascii => ch == '+',
    }
}

/// One cell of a GFM delimiter row, `:?-+:?` between optional whitespace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DelimiterCell {
    Empty,
    Colon,
    Dashes,
    Closed,
    Trailing,
    Bad,
}

impl DelimiterCell {
    fn push(self, ch: char) -> Self {
        match (self, ch) {
            (DelimiterCell::Empty, c) if c.is_whitespace() => DelimiterCell::Empty,
            (DelimiterCell::Empty, ':') => DelimiterCell::Colon,
            (DelimiterCell::Empty | DelimiterCell::Colon | DelimiterCell::Dashes, '-') => {
                DelimiterCell::Dashes
            }
            (DelimiterCell::Dashes, ':') => DelimiterCell::Closed,
            (DelimiterCell::Dashes | DelimiterCell::Closed | DelimiterCell::Trailing, c)
                if c.is_whitespace() =>
            {
                DelimiterCell::Trailing
            }
            _ => DelimiterCell::Bad,
        }
    }

    fn valid(self) -> bool {
        matches!(
            self,
            DelimiterCell::Dashes | DelimiterCell::Closed | DelimiterCell::Trailing
        )
    }
}

/// Classifies one line from its characters, seen once each, in order.
struct Classifier {
    /// Offset and character of the first and the last non-whitespace character (the last as its
    /// end offset).
    first: Option<(usize, char)>,
    last: Option<(usize, char)>,
    lead_spaces: usize,
    lead_other: bool,
    gap: bool,
    interior_gap: bool,
    count: usize,
    all_box: bool,
    any_non_wall: bool,
    all_ascii_rule: bool,
    previous_plus: bool,
    double_plus: bool,
    pipes: usize,
    escaped: bool,
    last_is_pipe: bool,
    delimiter_chars: bool,
    delimiter_cell: DelimiterCell,
    delimiter_invalid: usize,
    fence: Option<(char, usize)>,
    in_fence_run: bool,
    fence_rest_backtick: bool,
    fence_rest_text: bool,
}

impl Classifier {
    fn new() -> Self {
        Self {
            first: None,
            last: None,
            lead_spaces: 0,
            lead_other: false,
            gap: false,
            interior_gap: false,
            count: 0,
            all_box: true,
            any_non_wall: false,
            all_ascii_rule: true,
            previous_plus: false,
            double_plus: false,
            pipes: 0,
            escaped: false,
            last_is_pipe: false,
            delimiter_chars: true,
            delimiter_cell: DelimiterCell::Empty,
            delimiter_invalid: 0,
            fence: None,
            in_fence_run: false,
            fence_rest_backtick: false,
            fence_rest_text: false,
        }
    }

    fn push(&mut self, at: usize, ch: char) {
        if ch.is_whitespace() {
            if self.first.is_none() {
                if ch == ' ' {
                    self.lead_spaces += 1;
                } else {
                    self.lead_other = true;
                }
            } else {
                self.gap = true;
            }
            self.delimiter_cell = self.delimiter_cell.push(ch);
            self.in_fence_run = false;
            self.escaped = false;
            return;
        }
        if self.first.is_none() {
            self.first = Some((at, ch));
            if self.lead_ok() && matches!(ch, '`' | '~') {
                self.fence = Some((ch, 0));
                self.in_fence_run = true;
            }
        } else if self.gap {
            self.interior_gap = true;
        }
        self.gap = false;
        self.last = Some((at + ch.len_utf8(), ch));
        self.count += 1;

        if let Some((fence_ch, len)) = self.fence {
            if self.in_fence_run && ch == fence_ch {
                self.fence = Some((fence_ch, len + 1));
            } else {
                self.in_fence_run = false;
                self.fence_rest_text = true;
                self.fence_rest_backtick |= ch == '`';
            }
        }

        self.all_box &= is_box(ch);
        self.any_non_wall |= !is_box_wall(ch);

        self.all_ascii_rule &= matches!(ch, '+' | '-' | '=' | ':');
        self.double_plus |= ch == '+' && self.previous_plus;
        self.previous_plus = ch == '+';

        let pipe = ch == '|' && !self.escaped;
        self.pipes += usize::from(pipe);
        self.last_is_pipe = pipe;
        self.escaped = ch == '\\' && !self.escaped;

        if ch == '|' {
            self.delimiter_invalid += usize::from(!self.delimiter_cell.valid());
            self.delimiter_cell = DelimiterCell::Empty;
        } else {
            self.delimiter_chars &= matches!(ch, ':' | '-');
            self.delimiter_cell = self.delimiter_cell.push(ch);
        }
    }

    fn lead_ok(&self) -> bool {
        self.lead_spaces <= 3 && !self.lead_other
    }

    fn finish(self, start: usize, end: usize, next: usize) -> Line {
        let (Some((first_at, first)), Some((last_end, last))) = (self.first, self.last) else {
            return Line {
                start,
                end,
                next,
                text: end..end,
                kind: Kind::Blank,
                fence: None,
                pipe_cells: None,
                delimiter_cells: None,
            };
        };
        let count = self.count;
        let kind = if self.all_box && self.any_non_wall && count >= 2 && !self.interior_gap {
            Kind::BoxRule
        } else if count >= 2 && is_box_wall(first) && is_box_wall(last) {
            Kind::BoxContent
        } else if self.all_ascii_rule
            && !self.interior_gap
            && !self.double_plus
            && count >= 3
            && first == '+'
            && last == '+'
        {
            Kind::AsciiRule
        } else if count >= 2 && first == '|' && last == '|' {
            Kind::AsciiContent
        } else {
            Kind::Other
        };
        // Split by unescaped pipes, a line has `pipes + 1` cells; a pipe opening or closing the
        // line leaves an empty outer cell that does not count.
        let outer = usize::from(first == '|') + usize::from(self.last_is_pipe);
        let cells = self.pipes + 1 - outer;
        let lead_ok = self.lead_ok();
        let delimiter_invalid = self.delimiter_invalid + usize::from(!self.delimiter_cell.valid());
        Line {
            start,
            end,
            next,
            text: start + first_at..start + last_end,
            kind,
            fence: self
                .fence
                .filter(|&(_, len)| len >= 3)
                .map(|(ch, len)| FenceMark {
                    ch,
                    len,
                    opens: ch == '~' || !self.fence_rest_backtick,
                    closes: !self.fence_rest_text,
                }),
            pipe_cells: (lead_ok && self.pipes > 0).then_some(cells),
            delimiter_cells: (lead_ok
                && self.delimiter_chars
                && delimiter_invalid == outer
                && cells > 0)
                .then_some(cells),
        }
    }
}

/// Splits `source` into lines and classifies each, examining every byte once.
fn read_lines(source: &str, work: &mut usize) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut start = 0;
    while start < source.len() {
        let mut classifier = Classifier::new();
        let mut end = source.len();
        let mut next = source.len();
        for (at, ch) in source[start..].char_indices() {
            if ch == '\n' {
                end = start + at;
                next = end + 1;
                break;
            }
            classifier.push(at, ch);
        }
        *work += next - start;
        if source[start..end].ends_with('\r') {
            end -= 1;
        }
        lines.push(classifier.finish(start, end, next));
        start = next;
    }
    lines
}

fn scan<'a>(source: &'a str, work: &mut usize) -> Vec<Block<'a>> {
    let lines = read_lines(source, work);
    let mut blocks = Vec::new();
    let mut fence: Option<FenceMark> = None;
    // Lines before this index belong to a run of ASCII lines already found not to be a table;
    // they are still read as possible GFM lines, one by one.
    let mut ascii_checked = 0;
    let mut i = 0;
    while i < lines.len() {
        let line = &lines[i];
        if let Some(open) = fence {
            if line.fence.is_some_and(|mark| mark.closes(open)) {
                fence = None;
            }
            i += 1;
            continue;
        }
        if let Some(mark) = line.fence.filter(|mark| mark.opens) {
            fence = Some(mark);
            i += 1;
            continue;
        }
        let delimiter = lines.get(i + 1).and_then(|next| next.delimiter_cells);
        // A GFM header line followed by its delimiter row starts a Markdown table, not an ASCII
        // run (both are `|` lines; the Markdown slice stops before any `+---+` rule after it).
        let gfm_head = line.pipe_cells.is_some() && line.pipe_cells == delimiter;
        if let Some(grid) = line
            .kind
            .grid()
            .filter(|&grid| grid == Grid::Box || (i >= ascii_checked && !gfm_head))
        {
            let end = i + lines[i..]
                .iter()
                .take_while(|line| line.kind.grid() == Some(grid))
                .count();
            let run = &lines[i..end];
            if run.iter().any(|line| line.kind.is_rule())
                && run.iter().any(|line| !line.kind.is_rule())
            {
                blocks.push(grid_block(source, run, grid, work));
                i = end;
                continue;
            }
            if grid == Grid::Box {
                i = end;
                continue;
            }
            ascii_checked = end;
        }
        if gfm_head {
            let end = i
                + 2
                + lines[i + 2..]
                    .iter()
                    .take_while(|line| !line.ends_markdown_slice())
                    .count();
            gfm_blocks(source, &lines[i..end], &mut blocks, work);
            i = end;
            continue;
        }
        i += 1;
    }
    blocks
}

fn grid_block<'a>(source: &'a str, run: &[Line], grid: Grid, work: &mut usize) -> Block<'a> {
    Block {
        range: run[0].start..run[run.len() - 1].end,
        kind: grid_table(source, run, grid, work).map_or(BlockKind::Fallback, BlockKind::Table),
    }
}

/// A content line's cells: the trimmed source range of each column, `None` when blank.
struct ContentLine {
    /// Index into the run.
    index: usize,
    cells: Vec<Option<Range<usize>>>,
}

fn grid_table<'a>(source: &str, run: &[Line], grid: Grid, work: &mut usize) -> Option<Table<'a>> {
    let rules: Vec<Vec<usize>> = run
        .iter()
        .filter(|line| line.kind.is_rule())
        .map(|line| junction_columns(source, line, grid, work))
        .collect();
    // Column boundaries: the first rule with interior junctions, else the first rule's corners.
    let boundaries = rules
        .iter()
        .find(|columns| columns.len() > 2)
        .or_else(|| rules.first().filter(|columns| columns.len() == 2))?;
    if !rules.iter().all(|columns| is_subset(columns, boundaries)) {
        return None;
    }
    let columns = boundaries.len() - 1;

    let mut segments: Vec<Vec<ContentLine>> = Vec::new();
    let mut segment = Vec::new();
    for (index, line) in run.iter().enumerate() {
        if line.kind.is_rule() {
            if !segment.is_empty() {
                segments.push(std::mem::take(&mut segment));
            }
            continue;
        }
        let cells = content_cells(source, line, grid, boundaries, work)?;
        segment.push(ContentLine { index, cells });
    }
    if !segment.is_empty() {
        segments.push(segment);
    }
    // A one-column box with no rule between its lines is a boxed notice, not a table.
    if columns == 1 && segments.len() == 1 {
        return None;
    }
    let (header, body) = match segments.split_first() {
        Some((first, rest)) if !rest.is_empty() => (Some(joined_row(run, first, columns)), rest),
        _ => (None, segments.as_slice()),
    };
    // Exactly one body segment: one row per line. Two or more: one row per segment.
    let rows = match body {
        [only] => line_rows(run, only, columns),
        _ => body
            .iter()
            .map(|segment| joined_row(run, segment, columns))
            .collect(),
    };
    Some(Table {
        columns,
        header,
        rows,
    })
}

/// Display columns of a rule line's corners and junctions.
fn junction_columns(source: &str, line: &Line, grid: Grid, work: &mut usize) -> Vec<usize> {
    *work += line.end - line.start;
    let mut column = source[line.start..line.text.start].width();
    let mut junctions = Vec::new();
    for ch in source[line.text.clone()].chars() {
        if is_junction(ch, grid) {
            junctions.push(column);
        }
        column += ch.width().unwrap_or(0);
    }
    junctions
}

fn is_subset(columns: &[usize], boundaries: &[usize]) -> bool {
    let mut rest = boundaries.iter();
    columns
        .iter()
        .all(|column| rest.any(|boundary| boundary == column))
}

/// The cells of a content line, or `None` when its walls do not fit the boundaries.
///
/// A wall's display column is the `UnicodeWidthStr` width of the text before it, summed gap by
/// gap. The line fits when it holds a wall at every boundary column, its first and last walls
/// among them (text between other walls belongs to a cell); failing that, when its wall count
/// equals the boundary count, its walls are taken in order (a cell whose width the drawing tool
/// measured differently, such as an emoji or an Indic word).
fn content_cells(
    source: &str,
    line: &Line,
    grid: Grid,
    boundaries: &[usize],
    work: &mut usize,
) -> Option<Vec<Option<Range<usize>>>> {
    *work += line.end - line.start;
    // Walls as (byte offset, display column); `gaps[k]` is the trimmed text before wall `k`.
    let mut walls: Vec<(usize, usize)> = Vec::new();
    let mut gaps: Vec<Option<Range<usize>>> = Vec::new();
    let mut column = 0;
    let mut gap_start = line.start;
    let mut words: Option<Range<usize>> = None;
    for (at, ch) in source[line.start..line.end].char_indices() {
        let at = line.start + at;
        if is_wall(ch, grid) {
            let gap = &source[gap_start..at];
            *work += gap.len();
            column += gap.width();
            walls.push((at, column));
            gaps.push(words.take());
            column += ch.width().unwrap_or(0);
            gap_start = at + ch.len_utf8();
        } else if !ch.is_whitespace() {
            let end = at + ch.len_utf8();
            words = Some(words.map_or(at..end, |words| words.start..end));
        }
    }
    let chosen = boundary_walls(&walls, boundaries)
        .or_else(|| (walls.len() == boundaries.len()).then(|| (0..walls.len()).collect()))?;
    let wall_len = |k: usize| {
        source[walls[k].0..]
            .chars()
            .next()
            .map_or(0, char::len_utf8)
    };
    let cells = chosen
        .windows(2)
        .map(|pair| {
            let (left, right) = (pair[0], pair[1]);
            let start = gaps[left + 1]
                .as_ref()
                .map(|gap| gap.start)
                .or_else(|| (left + 1 < right).then(|| walls[left + 1].0))?;
            let end = gaps[right]
                .as_ref()
                .map(|gap| gap.end)
                .or_else(|| (right - 1 > left).then(|| walls[right - 1].0 + wall_len(right - 1)))?;
            Some(start..end)
        })
        .collect();
    Some(cells)
}

/// Indexes of the walls sitting on the boundary columns, when there is one on each and no wall
/// lies outside them.
fn boundary_walls(walls: &[(usize, usize)], boundaries: &[usize]) -> Option<Vec<usize>> {
    let mut chosen = Vec::with_capacity(boundaries.len());
    let mut k = 0;
    for &boundary in boundaries {
        while k < walls.len() && walls[k].1 < boundary {
            k += 1;
        }
        if walls.get(k).is_none_or(|wall| wall.1 != boundary) {
            return None;
        }
        chosen.push(k);
    }
    (chosen.first() == Some(&0) && chosen.last() == Some(&(walls.len() - 1))).then_some(chosen)
}

fn joined_row<'a>(run: &[Line], lines: &[ContentLine], columns: usize) -> Row<'a> {
    let range = run[lines[0].index].start..run[lines[lines.len() - 1].index].end;
    let cells = (0..columns)
        .map(|column| {
            Cell::Lines(
                lines
                    .iter()
                    .filter_map(|line| line.cells[column].clone())
                    .collect(),
            )
        })
        .collect();
    Row { range, cells }
}

/// One row per line, except that a line whose first cell is empty while another is not
/// continues the row above (a terminal wrap); the first line always starts a row.
fn line_rows<'a>(run: &[Line], lines: &[ContentLine], columns: usize) -> Vec<Row<'a>> {
    let mut groups: Vec<Range<usize>> = Vec::new();
    for (k, line) in lines.iter().enumerate() {
        let continues = line.cells[0].is_none() && line.cells[1..].iter().any(Option::is_some);
        match groups.last_mut() {
            Some(group) if continues => group.end = k + 1,
            _ => groups.push(k..k + 1),
        }
    }
    groups
        .into_iter()
        .map(|group| joined_row(run, &lines[group], columns))
        .collect()
}

/// A GFM table being collected from pulldown events.
struct GfmTable<'a> {
    columns: usize,
    header: Option<Row<'a>>,
    rows: Vec<Row<'a>>,
    row: Option<Row<'a>>,
    cell: Option<Vec<(Event<'a>, Range<usize>)>>,
    /// End of the last non-empty cell of the current row.
    covered: usize,
    /// A row holds text that no cell carries (pulldown drops cells past the header's count).
    lossy: bool,
}

/// Parses the slice `lines` (a GFM candidate up to the line that ends it, see
/// `Line::ends_markdown_slice`) once and pushes every top-level table in it.
fn gfm_blocks<'a>(source: &'a str, lines: &[Line], blocks: &mut Vec<Block<'a>>, work: &mut usize) {
    let offset = lines[0].start;
    let slice = &source[offset..lines[lines.len() - 1].end];
    *work += slice.len();
    let mut depth = 0usize;
    let mut table: Option<GfmTable<'a>> = None;
    let mut line = 0;
    for (event, range) in Parser::new_ext(slice, MARKDOWN).into_offset_iter() {
        let range = range.start + offset..range.end + offset;
        let Some(current) = table.as_mut() else {
            match event {
                Event::Start(Tag::Table(alignments)) if depth == 0 => {
                    table = Some(GfmTable {
                        columns: alignments.len(),
                        header: None,
                        rows: Vec::new(),
                        row: None,
                        cell: None,
                        covered: 0,
                        lossy: false,
                    });
                }
                Event::Start(_) => depth += 1,
                Event::End(_) => depth = depth.saturating_sub(1),
                _ => {}
            }
            continue;
        };
        match event {
            Event::Start(Tag::TableHead | Tag::TableRow) => {
                current.covered = range.start;
                current.row = Some(Row {
                    range: trim_line_break(source, range),
                    cells: Vec::new(),
                });
            }
            Event::End(end @ (TagEnd::TableHead | TagEnd::TableRow)) => {
                if let Some(mut row) = current.row.take() {
                    let tail = &source[current.covered.max(row.range.start)..row.range.end];
                    *work += tail.len();
                    current.lossy |= tail.chars().any(|ch| ch != '|' && !ch.is_whitespace());
                    current.lossy |= row.cells.len() > current.columns;
                    row.cells
                        .resize_with(current.columns, || Cell::Inline(Vec::new()));
                    if end == TagEnd::TableHead {
                        current.header = Some(row);
                    } else {
                        current.rows.push(row);
                    }
                }
            }
            Event::Start(Tag::TableCell) => current.cell = Some(Vec::new()),
            Event::End(TagEnd::TableCell) => {
                if !range.is_empty() {
                    current.covered = range.end;
                }
                if let (Some(row), Some(cell)) = (current.row.as_mut(), current.cell.take()) {
                    row.cells.push(Cell::Inline(cell));
                }
            }
            Event::End(TagEnd::Table) => {
                let Some(done) = table.take() else { continue };
                let first = line_at(lines, &mut line, range.start);
                let last = line_at(
                    lines,
                    &mut line,
                    range.end.saturating_sub(1).max(range.start),
                );
                let range = first.start..last.end;
                blocks.push(Block {
                    range,
                    kind: if done.lossy {
                        BlockKind::Fallback
                    } else {
                        BlockKind::Table(Table {
                            columns: done.columns,
                            header: done.header,
                            rows: done.rows,
                        })
                    },
                });
            }
            event => {
                if let Some(cell) = current.cell.as_mut() {
                    cell.push((event, range));
                }
            }
        }
    }
}

fn trim_line_break(source: &str, range: Range<usize>) -> Range<usize> {
    let text = source[range.clone()].trim_end_matches(['\n', '\r']);
    range.start..range.start + text.len()
}

/// The line holding `offset`; `k` only moves forward, so a pass over one slice stays linear.
fn line_at<'l>(lines: &'l [Line], k: &mut usize, offset: usize) -> &'l Line {
    while *k + 1 < lines.len() && lines[*k].next <= offset {
        *k += 1;
    }
    &lines[*k]
}

#[cfg(test)]
mod tests {
    use super::*;

    const LANES: &str = include_str!("../../tests/fixtures/text/tables/lanes.txt");
    const MULTILINE: &str = include_str!("../../tests/fixtures/text/tables/multiline.txt");
    const BOX: &str = "┌───┬───┐\n│ h │ i │\n├───┼───┤\n│ a │ b │\n└───┴───┘";
    const GFM: &str = "| h | i |\n|---|---|\n| a | b |";

    fn cell_text(source: &str, cell: &Cell<'_>) -> String {
        match cell {
            Cell::Lines(parts) => parts
                .iter()
                .map(|range| &source[range.clone()])
                .collect::<Vec<_>>()
                .join(" "),
            Cell::Inline(events) => {
                let mut out = String::new();
                for (event, _) in events {
                    match event {
                        Event::Text(text) | Event::Code(text) => out.push_str(text),
                        Event::InlineHtml(html) if html.starts_with("<br") => out.push(' '),
                        Event::SoftBreak => out.push(' '),
                        _ => {}
                    }
                }
                out.trim().to_string()
            }
        }
    }

    fn texts(source: &str, row: &Row<'_>) -> Vec<String> {
        row.cells
            .iter()
            .map(|cell| cell_text(source, cell))
            .collect()
    }

    fn table<'b, 'a>(block: &'b Block<'a>) -> &'b Table<'a> {
        match &block.kind {
            BlockKind::Table(table) => table,
            BlockKind::Fallback => panic!("expected a table, got a fallback at {:?}", block.range),
        }
    }

    fn header(source: &str, table: &Table<'_>) -> Vec<String> {
        texts(source, table.header.as_ref().expect("table has a header"))
    }

    fn rows(source: &str, table: &Table<'_>) -> Vec<Vec<String>> {
        table.rows.iter().map(|row| texts(source, row)).collect()
    }

    fn only_table(source: &str) -> Table<'_> {
        let blocks = find_blocks(source);
        assert_eq!(blocks.len(), 1, "blocks of {source:?}: {blocks:?}");
        table(&blocks[0]).clone()
    }

    fn line_end(source: &str, from: usize) -> usize {
        source[from..]
            .find(['\r', '\n'])
            .map_or(source.len(), |at| from + at)
    }

    /// Alphanumeric words, sorted: the words of a block's source and of its cells must match.
    fn words<'s>(text: impl IntoIterator<Item = &'s str>) -> Vec<String> {
        let mut out: Vec<String> = text
            .into_iter()
            .flat_map(|part| part.split(|c: char| !c.is_alphanumeric()))
            .filter(|word| !word.is_empty())
            .map(str::to_string)
            .collect();
        out.sort();
        out
    }

    fn assert_cells_hold_every_word(source: &str, block: &Block<'_>) {
        let table = table(block);
        let cells: Vec<String> = table
            .header
            .iter()
            .chain(&table.rows)
            .flat_map(|row| texts(source, row))
            .collect();
        assert_eq!(
            words(cells.iter().map(String::as_str)),
            words([&source[block.range.clone()]]),
            "words of {:?}",
            &source[block.range.clone()]
        );
    }

    fn assert_multiline_cells(source: &str) -> Vec<Block<'_>> {
        let blocks = find_blocks(source);
        assert_eq!(blocks.len(), 2, "{blocks:?}");
        let boxed = table(&blocks[0]);
        assert_eq!(boxed.columns, 3);
        assert_eq!(header(source, boxed), ["Lane", "Progress", "Owner"]);
        assert_eq!(
            rows(source, boxed),
            [
                ["B, the walk", "Task B1 committed, working on B2.", "Opus"],
                ["E", "9 files changed", "gpt-6.1-sol"],
            ]
        );
        let gfm = table(&blocks[1]);
        assert_eq!(gfm.columns, 3);
        assert_eq!(header(source, gfm), ["Lane", "Model", "Progress"]);
        assert_eq!(
            rows(source, gfm),
            [
                ["B, the walk", "Opus", "Task B1 committed (b574c34)."],
                ["E", "gpt-6.1-sol", "9 files changed, unstaged"],
            ]
        );
        for block in &blocks {
            assert_cells_hold_every_word(source, block);
        }
        blocks
    }

    #[test]
    fn lanes_box_table_parses_to_a_header_and_three_rows() {
        let blocks = find_blocks(LANES);
        assert_eq!(blocks.len(), 1, "{blocks:?}");
        let lanes = table(&blocks[0]);
        assert_eq!(lanes.columns, 3);
        assert_eq!(header(LANES, lanes), ["Lane", "Model", "Progress"]);
        assert_eq!(
            rows(LANES, lanes),
            [
                [
                    "B, the walk (critical path)",
                    "Opus",
                    "Task B1 committed (b574c34): the per-pass host ledger at the network layer. Working on B2.",
                ],
                [
                    "A, access and admission",
                    "Opus",
                    "Starting point verified, 10 files changed, first commit not yet made",
                ],
                [
                    "E, settle and checker",
                    "gpt-6.1-sol",
                    "9 files changed and left unstaged (its sandbox can't commit). It notes its migration needs the second reviewer, as planned.",
                ],
            ]
        );
        assert_eq!(blocks[0].range.start, LANES.find('┌').unwrap());
        assert_eq!(
            blocks[0].range.end,
            line_end(LANES, LANES.find('└').unwrap())
        );
        assert_cells_hold_every_word(LANES, &blocks[0]);
    }

    #[test]
    fn wrapped_cells_join_by_column() {
        let blocks = assert_multiline_cells(MULTILINE);
        let first = &table(&blocks[0]).rows[0];
        let start = MULTILINE.find("│ B, the").unwrap();
        let end = line_end(MULTILINE, MULTILINE.find("│ walk").unwrap());
        assert_eq!(first.range, start..end);
    }

    #[test]
    fn crlf_lines_parse_like_lf() {
        let crlf = MULTILINE.replace('\n', "\r\n");
        let blocks = assert_multiline_cells(&crlf);
        for block in &blocks {
            assert!(
                !crlf[block.range.clone()].ends_with('\r'),
                "{:?}",
                block.range
            );
            let table = table(block);
            for row in table.header.iter().chain(&table.rows) {
                assert!(!crlf[row.range.clone()].ends_with('\r'), "{:?}", row.range);
            }
        }
    }

    #[test]
    fn ascii_table_parses() {
        let source = "+------+-----+\n| Name | Qty |\n+======+=====+\n| a    | 1   |\n| b    | 2   |\n+------+-----+";
        let ascii = only_table(source);
        assert_eq!(header(source, &ascii), ["Name", "Qty"]);
        assert_eq!(rows(source, &ascii), [["a", "1"], ["b", "2"]]);
    }

    #[test]
    fn heavy_double_and_rounded_sets_parse() {
        for source in [
            "┏━━━┳━━━┓\n┃ h ┃ i ┃\n┣━━━╋━━━┫\n┃ a ┃ b ┃\n┗━━━┻━━━┛",
            "╔═══╦═══╗\n║ h ║ i ║\n╠═══╬═══╣\n║ a ║ b ║\n╚═══╩═══╝",
            "╭───┬───╮\n│ h │ i │\n├───┼───┤\n│ a │ b │\n╰───┴───╯",
        ] {
            let grid = only_table(source);
            assert_eq!(header(source, &grid), ["h", "i"], "{source}");
            assert_eq!(rows(source, &grid), [["a", "b"]], "{source}");
        }
    }

    #[test]
    fn cjk_cells_use_display_width() {
        let source = "┌──────┬───┐\n│ 名前 │ a │\n├──────┼───┤\n│ 東京 │ b │\n└──────┴───┘";
        let cjk = only_table(source);
        assert_eq!(header(source, &cjk), ["名前", "a"]);
        assert_eq!(rows(source, &cjk), [["東京", "b"]]);
        // A wall character inside a cell: only display columns find the boundaries here.
        let source =
            "┌──────┬─────┐\n│ 名前 │ a│b │\n├──────┼─────┤\n│ 東京 │ c   │\n└──────┴─────┘";
        let cjk = only_table(source);
        assert_eq!(header(source, &cjk), ["名前", "a│b"]);
        assert_eq!(rows(source, &cjk), [["東京", "c"]]);
    }

    #[test]
    fn emoji_and_indic_cells_keep_box_tables() {
        // Drawn with the widths unicode-width gives (an emoji is two columns wide).
        let aligned = "┌─────────┬────────┐\n│ Check   │ Note   │\n├─────────┼────────┤\n│ ⚠️ warn │ x      │\n│ ✅ done │ नमस्ते   │\n└─────────┴────────┘";
        // Drawn by a tool that counts characters, so the walls sit off the rule's columns.
        let by_chars = "┌─────────┬────────┐\n│ Check   │ Note   │\n├─────────┼────────┤\n│ ⚠️ warn  │ x      │\n│ ✅ done  │ नमस्ते │\n└─────────┴────────┘";
        for source in [aligned, by_chars] {
            let blocks = find_blocks(source);
            assert_eq!(blocks.len(), 1, "{source}");
            let grid = table(&blocks[0]);
            assert_eq!(header(source, grid), ["Check", "Note"], "{source}");
            assert_eq!(
                rows(source, grid),
                [["⚠️ warn", "x"], ["✅ done", "नमस्ते"]],
                "{source}"
            );
            assert_cells_hold_every_word(source, &blocks[0]);
        }
    }

    #[test]
    fn gfm_alignment_colons_escapes_and_breaks() {
        let source = "| a | b |\n|:--|--:|\n| x \\| y | z<br>w |";
        let gfm = only_table(source);
        assert_eq!(gfm.columns, 2);
        assert_eq!(header(source, &gfm), ["a", "b"]);
        assert_eq!(rows(source, &gfm), [["x | y", "z w"]]);
    }

    #[test]
    fn gfm_rows_never_lose_cells() {
        let short = "| a | b |\n|---|---|\n| 1 |";
        let gfm = only_table(short);
        assert_eq!(rows(short, &gfm), [["1", ""]]);
        // pulldown-cmark drops cells past the header's count: that table is not read as a grid.
        let long = "| a | b |\n|---|---|\n| 1 | 2 | 3 |";
        let blocks = find_blocks(long);
        assert_eq!(blocks.len(), 1, "{blocks:?}");
        assert_eq!(blocks[0].kind, BlockKind::Fallback);
        assert_eq!(blocks[0].range, 0..long.len());
    }

    #[test]
    fn continuation_lines_join_the_row_above() {
        let source = "┌───┬───┐\n│ h │ i │\n├───┼───┤\n│ a │ b │\n│   │ c │\n│ d │ e │\n└───┴───┘";
        let grid = only_table(source);
        assert_eq!(rows(source, &grid), [["a", "b c"], ["d", "e"]]);
        let start = source.find("│ a").unwrap();
        assert_eq!(
            grid.rows[0].range,
            start..line_end(source, source.find("│   │ c").unwrap())
        );
    }

    #[test]
    fn no_header_rule_reads_each_line_as_a_row() {
        let source = "┌───┬───┐\n│ a │ b │\n│ c │ d │\n└───┴───┘";
        let grid = only_table(source);
        assert_eq!(grid.header, None);
        assert_eq!(rows(source, &grid), [["a", "b"], ["c", "d"]]);
    }

    #[test]
    fn body_segments_decide_rows_per_line_or_per_segment() {
        // Two body segments: one row per segment, the lines of a segment joined by column.
        let totals = "┌───────┬───┐\n│ Item  │ n │\n├───────┼───┤\n│ a     │ 1 │\n│ b     │ 2 │\n├───────┼───┤\n│ Total │ 3 │\n└───────┴───┘";
        let grid = only_table(totals);
        assert_eq!(header(totals, &grid), ["Item", "n"]);
        assert_eq!(rows(totals, &grid), [["a b", "1 2"], ["Total", "3"]]);
        // Exactly one body segment: one row per line.
        let single = "┌───────┬───┐\n│ Item  │ n │\n├───────┼───┤\n│ a     │ 1 │\n│ b     │ 2 │\n│ Total │ 3 │\n└───────┴───┘";
        let grid = only_table(single);
        assert_eq!(
            rows(single, &grid),
            [["a", "1"], ["b", "2"], ["Total", "3"]]
        );
    }

    #[test]
    fn one_column_boxes_need_an_interior_rule() {
        for notice in [
            "╭────────────────────────╮\n│ Update available       │\n│ Restart to install it. │\n╰────────────────────────╯",
            "┌──────┐\n│ note │\n└──────┘",
        ] {
            let blocks = find_blocks(notice);
            assert_eq!(blocks.len(), 1, "{blocks:?}");
            assert_eq!(blocks[0].kind, BlockKind::Fallback, "{notice}");
            assert_eq!(blocks[0].range, 0..notice.len());
        }
        let headed = "┌───┐\n│ h │\n├───┤\n│ a │\n│ b │\n└───┘";
        let grid = only_table(headed);
        assert_eq!(grid.columns, 1);
        assert_eq!(header(headed, &grid), ["h"]);
        assert_eq!(rows(headed, &grid), [["a"], ["b"]]);
    }

    #[test]
    fn malformed_box_table_falls_back() {
        for source in [
            "┌───┬───┐\n│ h │ i │\n├───┼───┤\n│ a   b │\n└───┴───┘",
            "┌───┬───┐\n│ h │ i │\n├────┼──┤\n│ a │ b │\n└───┴───┘",
        ] {
            let text = format!("Before.\n\n{source}\n\nAfter.");
            let blocks = find_blocks(&text);
            assert_eq!(blocks.len(), 1, "{blocks:?}");
            assert_eq!(blocks[0].kind, BlockKind::Fallback, "{source}");
            let start = text.find(source).unwrap();
            assert_eq!(blocks[0].range, start..start + source.len());
        }
    }

    #[test]
    fn tables_at_the_edges_and_two_in_one_text() {
        let first = format!("{BOX}\nAfter.");
        assert_eq!(find_blocks(&first)[0].range, 0..BOX.len());
        let first = format!("{GFM}\n\nAfter.");
        assert_eq!(find_blocks(&first)[0].range, 0..GFM.len());
        for (last, table_len) in [
            (format!("Before.\n\n{GFM}"), GFM.len()),
            (format!("Before.\n{BOX}"), BOX.len()),
        ] {
            let blocks = find_blocks(&last);
            assert_eq!(blocks.len(), 1, "{blocks:?}");
            assert_eq!(blocks[0].range, last.len() - table_len..last.len());
        }
        let both = format!("{BOX}\n\nMiddle paragraph.\n\n{GFM}");
        let blocks = find_blocks(&both);
        assert_eq!(blocks.len(), 2, "{blocks:?}");
        let middle = both.find("Middle paragraph.").unwrap();
        let middle = middle..middle + "Middle paragraph.".len();
        for block in &blocks {
            table(block);
            assert!(
                block.range.end <= middle.start || block.range.start >= middle.end,
                "{block:?}"
            );
        }
    }

    #[test]
    fn dividers_and_loose_pipes_are_not_tables() {
        for source in ["Intro\n────────\nText", "| just | pipes |", "a | b\nc | d"]
        {
            assert_eq!(find_blocks(source), [], "{source}");
        }
    }

    #[test]
    fn fenced_tables_are_not_candidates() {
        let boxed = &MULTILINE[..MULTILINE.find("\n\n").unwrap()];
        for fenced in [
            format!("```\n{boxed}\n```\n"),
            format!("~~~\n{boxed}\n~~~"),
            format!("Before.\n\n```text\n{boxed}\n```\n\nAfter."),
            format!("```\n{GFM}\n```"),
            format!("  ````\n{boxed}\n```\n{GFM}"),
        ] {
            assert_eq!(find_blocks(&fenced), [], "{fenced}");
        }
        let after = format!("```\n{boxed}\n```\n\n{BOX}");
        let blocks = find_blocks(&after);
        assert_eq!(blocks.len(), 1, "{blocks:?}");
        assert_eq!(blocks[0].range.start, after.len() - BOX.len());
    }

    #[test]
    fn a_table_followed_directly_by_a_fence_is_real() {
        let source = format!("{GFM}\n```\n{BOX}\n\n{GFM}\n```\n\n{GFM}");
        let blocks = find_blocks(&source);
        assert_eq!(blocks.len(), 2, "{blocks:?}");
        assert_eq!(blocks[0].range, 0..GFM.len());
        assert_eq!(blocks[1].range, source.len() - GFM.len()..source.len());
        for block in &blocks {
            assert_eq!(rows(&source, table(block)), [["a", "b"]]);
        }
    }

    #[test]
    fn grid_tables_after_a_markdown_like_slice_are_found() {
        let ascii = "+---+---+\n| h | i |\n+===+===+\n| a | b |\n+---+---+";
        for (prefix, grid) in [
            ("# a | b\n|-|-|\n", BOX),
            ("# a | b\n|-|-|\n", ascii),
            ("# Next\n", BOX),
        ] {
            let source = format!("{prefix}{grid}");
            let blocks = find_blocks(&source);
            assert_eq!(blocks.len(), 1, "{source}\n{blocks:?}");
            assert_eq!(blocks[0].range, prefix.len()..source.len());
            let grid = table(&blocks[0]);
            assert_eq!(header(&source, grid), ["h", "i"], "{source}");
            assert_eq!(rows(&source, grid), [["a", "b"]], "{source}");
        }
    }

    #[test]
    fn gfm_body_with_box_walls_keeps_rows() {
        let source = "h | i\n--- | ---\n│ a | b │\nc | d";
        let blocks = find_blocks(source);
        assert_eq!(blocks.len(), 1, "{blocks:?}");
        assert_eq!(blocks[0].range, 0..source.len());
        assert_eq!(table(&blocks[0]).rows.len(), 2, "{blocks:?}");
    }

    #[test]
    fn a_markdown_table_and_a_grid_in_one_slice_are_two_blocks() {
        let ascii = "+---+---+\n| h | i |\n+===+===+\n| a | b |\n+---+---+";
        for (middle, grid) in [("", BOX), ("", ascii), ("# Next\n", BOX)] {
            let source = format!("{GFM}\n{middle}{grid}");
            let blocks = find_blocks(&source);
            assert_eq!(blocks.len(), 2, "{source}\n{blocks:?}");
            assert_eq!(blocks[0].range, 0..GFM.len());
            assert_eq!(blocks[1].range, source.len() - grid.len()..source.len());
            for block in &blocks {
                assert_eq!(rows(&source, table(block)), [["a", "b"]], "{source}");
            }
        }
    }

    #[test]
    fn tables_inside_block_quotes_are_not_blocks() {
        let quoted = "> | c | d |\n> |---|---|\n> | 3 | 4 |";
        assert_eq!(find_blocks(quoted), []);
        let source = format!("{GFM}\n{quoted}");
        let blocks = find_blocks(&source);
        assert_eq!(blocks.len(), 1, "{blocks:?}");
        assert_eq!(blocks[0].range, 0..GFM.len());
    }

    #[test]
    fn detection_work_is_linear() {
        let hostile = [
            "| a | b |\n".repeat(20_000),
            "+--+\n| x\n".repeat(10_000),
            "─".repeat(100_000),
            "│ a │ b │\n".repeat(20_000),
            "┌──┐\n│ a │\n".repeat(10_000),
            "# a | b\n|-|-|\n".repeat(20_000),
            "| a |\n|-|\n# h\n".repeat(10_000),
            format!("# a | b\n|-|-|\n{BOX}\n").repeat(2_000),
        ];
        for source in &hostile {
            let (_, work) = find_blocks_counted(source);
            let head: String = source.chars().take(12).collect();
            assert!(
                work <= 4 * source.len(),
                "work {work} over {} bytes for {head:?}",
                source.len()
            );
        }
        // One pulldown parse of the slice yields every table in it.
        let (blocks, _) = find_blocks_counted(&hostile[6]);
        assert_eq!(blocks.len(), 10_000);
        // Every box after a Markdown-like slice is still found.
        let (blocks, _) = find_blocks_counted(&hostile[7]);
        assert_eq!(blocks.len(), 2_000);
    }
}
