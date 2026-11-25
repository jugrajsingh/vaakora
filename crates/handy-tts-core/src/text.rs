use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use regex::Regex;
use std::collections::VecDeque;
use std::ops::Range;
use std::sync::Arc;
use thiserror::Error;

use crate::formatted::tables::{self, BlockKind, Cell, Table, TableStyle};
use crate::vocabulary::{TechnicalOptions, Vocabulary, speak_technical};

/// Request size used by the streaming session to keep synthesis lanes supplied.
pub const STREAMING_CHUNK_CHARS: usize = 100;
const SENTENCE_PUNCTUATION: [char; 6] = ['.', ',', ';', ':', '!', '?'];

/// A spoken chunk with its original UTF-16 source range and trailing pause.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct TextChunk {
    pub index: usize,
    pub text: String,
    pub source_start: u32,
    pub source_end: u32,
    pub pause_ms: u32,
}
/// One written word and what it became: its UTF-16 range in the source and its UTF-16 range in
/// the chunk's spoken text. A skipped word has an empty spoken range (and may sit outside the
/// chunk's source range); a word split across chunks has one span per part.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct WordSpan {
    pub source_start: u32,
    pub source_end: u32,
    pub spoken_start: u32,
    pub spoken_end: u32,
}
/// A chunk with the span of every written word it speaks, in source order. A synthetic period
/// belongs to no span.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct AlignedChunk {
    pub chunk: TextChunk,
    pub words: Vec<WordSpan>,
}
/// Prepares `source` to the end with a fresh streaming cursor: every chunk with its word spans.
pub fn prepare_reading(
    source: &str,
    read_code: bool,
    vocabulary: Option<Arc<Vocabulary>>,
    technical: TechnicalOptions,
) -> Result<Vec<AlignedChunk>, TextError> {
    let chunks = prepare_written(source, read_code, vocabulary, technical)?;
    Ok(chunks.into_iter().map(|(aligned, _)| aligned).collect())
}
/// `prepare_reading`, each chunk with the written word behind each of its spans.
pub(crate) fn prepare_written(
    source: &str,
    read_code: bool,
    vocabulary: Option<Arc<Vocabulary>>,
    technical: TechnicalOptions,
) -> Result<Vec<(AlignedChunk, Vec<String>)>, TextError> {
    let mut cursor = TextCursor::streaming_with(source, read_code, vocabulary, technical)?;
    let mut chunks = Vec::new();
    while let Some(chunk) = cursor.next_written_chunk()? {
        chunks.push(chunk);
    }
    Ok(chunks)
}
/// Errors from normalizer initialization or source range conversion.
#[derive(Debug, Error)]
pub enum TextError {
    #[error("text normalizer initialization failed")]
    Regex(#[from] regex::Error),
    #[error("source character range overflow")]
    Range,
}
struct Piece {
    text: String,
    range: Range<usize>,
    pause: u32,
    /// True for a skipped token: `text` is empty or the one mark it left (`ABC-123.` read as
    /// `.`), still to join the spoken word before it.
    skipped: bool,
    /// The written words this piece speaks, in source order.
    words: Vec<Word>,
    /// The source range a chunk holding this piece covers instead of `range`: the table row (or
    /// the table's opening or closing lines) the piece is spoken for. Every piece of a row
    /// carries it, so each chunk of a row highlights and resumes as the whole row, while `range`
    /// and the word spans stay the word's own.
    row: Option<Range<usize>>,
    /// For a boundary marker that ends a table value: the mark its chunk ends with, unless the
    /// chunk text already ends in punctuation.
    mark: Option<char>,
}
/// One written word inside a piece: its source byte range, the word as written, and the byte
/// range of the piece's text it is spoken as (empty when skipped).
#[derive(Clone)]
struct Word {
    source: Range<usize>,
    written: String,
    spoken: Range<usize>,
}
impl Piece {
    /// A piece that speaks no written word: a boundary marker or a pause.
    fn marker(text: String, range: Range<usize>, pause: u32) -> Piece {
        Piece {
            text,
            range,
            pause,
            skipped: false,
            words: Vec::new(),
            row: None,
            mark: None,
        }
    }
    /// A fixed phrase or column label spoken for the table row `row`: no written word.
    fn label(text: String, row: Range<usize>) -> Piece {
        Piece {
            row: Some(row.clone()),
            ..Piece::marker(text, row, 0)
        }
    }
    /// The source range a chunk holding this piece covers.
    fn span(&self) -> &Range<usize> {
        self.row.as_ref().unwrap_or(&self.range)
    }
    /// A piece whose whole text is the reading of one written word.
    fn word(text: String, range: Range<usize>, written: String, skipped: bool) -> Piece {
        let spoken = if skipped { 0..0 } else { 0..text.len() };
        let words = vec![Word {
            source: range.clone(),
            written,
            spoken,
        }];
        Piece {
            text,
            range,
            pause: 0,
            skipped,
            words,
            row: None,
            mark: None,
        }
    }
    /// Appends skipped words at the end of the text, with empty spoken ranges.
    fn absorb(&mut self, skipped: &[Word]) {
        let end = self.text.len();
        self.words.extend(skipped.iter().map(|word| Word {
            spoken: end..end,
            ..word.clone()
        }));
    }
}
struct Fragment<'a> {
    value: pulldown_cmark::CowStr<'a>,
    range: Range<usize>,
    offset: usize,
    base: Option<usize>,
    inline: bool,
    html: bool,
    html_exhausted: bool,
}
/// What the cursor reads: a Markdown event of the prose around tables, a table block, or one
/// spoken part of the table being read.
enum Item<'a> {
    Event(Event<'a>, Range<usize>),
    /// A table block, turned into the items below when the cursor reaches it.
    Table(Range<usize>, Table<'a>),
    /// The source range every piece carries up to the next `Row` (`None`: prose again).
    Row(Option<Range<usize>>),
    /// One word of a fixed phrase or column label, spoken with no word span.
    Label(String),
    /// Ends a spoken value or sentence: a boundary with this pause, and the mark its chunk ends
    /// with (`None`: the synthetic period of any boundary of 250 or more).
    End(u32, Option<char>),
    /// A table or fallback block starts at this byte inside an open paragraph, list item or
    /// heading (prose on the line before it, no blank line between): the prose before it ends
    /// there with that block's boundary pause.
    BlockStart(usize, u32),
}
/// The Markdown events of the whole source, with source byte ranges.
fn document_events(source: &str) -> impl Iterator<Item = (Event<'_>, Range<usize>)> {
    Parser::new_ext(
        source,
        Options::ENABLE_TABLES | Options::ENABLE_FOOTNOTES | Options::ENABLE_STRIKETHROUGH,
    )
    .into_offset_iter()
}
/// The end of the line break after byte `end` (or `end` when no line break follows).
fn after_line_break(source: &str, end: usize) -> usize {
    let rest = &source[end..];
    end + if rest.starts_with("\r\n") {
        2
    } else {
        usize::from(rest.starts_with('\n'))
    }
}
/// The cursor's input: `document`, the events of one Markdown parse of the whole source (so
/// reference links and footnotes keep their definitions wherever they sit), with each table or
/// fallback block put in place of the events inside it. Events that only overlap a block (a
/// paragraph or list around it) are kept, after the block. Text without a table block reads
/// exactly as the parse does; every event is read once.
fn source_items<'a>(
    source: &'a str,
    document: impl Iterator<Item = (Event<'a>, Range<usize>)> + 'a,
) -> impl Iterator<Item = Item<'a>> {
    let mut blocks = tables::find_blocks(source).into_iter().peekable();
    let mut document = document.peekable();
    let mut queue: VecDeque<Item<'a>> = VecDeque::new();
    // The boundary pause of each open Markdown block, innermost last (0: none).
    let mut open: Vec<u32> = Vec::new();
    let mut track = move |item: Item<'a>| {
        if let Item::Event(event, _) = &item {
            match event {
                Event::Start(Tag::Paragraph | Tag::HtmlBlock) => open.push(450),
                Event::Start(Tag::Heading { .. }) => open.push(600),
                Event::Start(Tag::Item) => open.push(300),
                Event::Start(_) => open.push(0),
                Event::End(_) => {
                    open.pop();
                }
                _ => {}
            }
        }
        let glued = open.iter().rev().copied().find(|&pause| pause > 0);
        (item, glued)
    };
    let mut glued = None;
    std::iter::from_fn(move || {
        loop {
            if let Some(item) = queue.pop_front() {
                let (item, now) = track(item);
                glued = now;
                return Some(item);
            }
            let at_block = match (blocks.peek(), document.peek()) {
                (Some(block), Some((_, range))) => range.start >= block.range.start,
                (Some(_), None) => true,
                (None, _) => false,
            };
            if !at_block {
                let (event, range) = document.next()?;
                let (item, now) = track(Item::Event(event, range));
                glued = now;
                return Some(item);
            }
            let block = blocks.next()?;
            let limit = after_line_break(source, block.range.end);
            let mut inside = Vec::new();
            let mut around = Vec::new();
            while let Some((event, range)) = document.next_if(|(_, range)| range.start < limit) {
                if range.start >= block.range.start && range.end <= limit {
                    inside.push((event, range));
                } else {
                    around.push(Item::Event(event, range));
                }
            }
            if let Some(pause) = glued {
                queue.push_back(Item::BlockStart(block.range.start, pause));
            }
            match block.kind {
                BlockKind::Table(table) => {
                    queue.push_back(Item::Table(block.range, with_document_cells(table, inside)))
                }
                BlockKind::Fallback(read) => {
                    queue.extend(fallback_items(source, block.range, read));
                }
            }
            queue.extend(around);
        }
    })
}
/// The inline events of one Markdown cell, with source byte ranges.
type CellEvents<'a> = Vec<(Event<'a>, Range<usize>)>;
/// A Markdown table with each cell's events taken from the whole-source parse (`inside`, the
/// events inside the block), so a reference or footnote in a cell reads as anywhere else. A
/// table whose parse holds other rows (a box or ASCII table, or one read differently in its
/// context) keeps its own cells.
fn with_document_cells<'a>(
    mut table: Table<'a>,
    inside: Vec<(Event<'a>, Range<usize>)>,
) -> Table<'a> {
    let mut rows: Vec<Vec<CellEvents<'a>>> = Vec::new();
    let mut cell: Option<CellEvents<'a>> = None;
    for (event, range) in inside {
        match event {
            Event::Start(Tag::TableHead | Tag::TableRow) => rows.push(Vec::new()),
            Event::Start(Tag::TableCell) => cell = Some(Vec::new()),
            Event::End(TagEnd::TableCell) => {
                if let (Some(row), Some(done)) = (rows.last_mut(), cell.take()) {
                    row.push(done);
                }
            }
            Event::Start(Tag::Table(_))
            | Event::End(TagEnd::Table | TagEnd::TableHead | TagEnd::TableRow) => {}
            event => {
                if let Some(cell) = cell.as_mut() {
                    cell.push((event, range));
                }
            }
        }
    }
    let ours = usize::from(table.header.is_some()) + table.rows.len();
    let inline = table
        .header
        .iter()
        .chain(&table.rows)
        .all(|row| row.cells.iter().all(|cell| matches!(cell, Cell::Inline(_))));
    if rows.len() != ours || !inline || rows.iter().any(|row| row.len() > table.columns) {
        return table;
    }
    for (row, cells) in table.header.iter_mut().chain(&mut table.rows).zip(rows) {
        let mut cells = cells.into_iter();
        for slot in &mut row.cells {
            *slot = Cell::Inline(cells.next().unwrap_or_default());
        }
    }
    table
}
/// A fallback block read as one paragraph in source order: its parts as the lines of a box cell
/// (a soft break between them), each word with its own range, then the paragraph's boundary.
fn fallback_items<'a>(
    source: &'a str,
    block: Range<usize>,
    read: Vec<Range<usize>>,
) -> impl Iterator<Item = Item<'a>> {
    std::iter::once(Item::Event(
        Event::Start(Tag::Paragraph),
        block.start..block.start,
    ))
    .chain(cell_items(source, Cell::Lines(read)))
    .chain(std::iter::once(Item::Event(
        Event::End(TagEnd::Paragraph),
        block.end..block.end,
    )))
}
/// A cell's words as Markdown events: a box or ASCII cell's line slices as text with a soft break
/// between them, a Markdown cell's own inline events.
fn cell_items<'a>(source: &'a str, cell: Cell<'a>) -> Vec<Item<'a>> {
    match cell {
        Cell::Lines(lines) => {
            let mut items = Vec::new();
            for range in lines {
                if !items.is_empty() {
                    items.push(Item::Event(Event::SoftBreak, range.start..range.start));
                }
                items.push(Item::Event(
                    Event::Text(source[range.clone()].into()),
                    range,
                ));
            }
            items
        }
        Cell::Inline(events) => events
            .into_iter()
            .map(|(event, range)| Item::Event(event, range))
            .collect(),
    }
}
/// A spoken phrase as one label per word, so a long phrase chunks between words like prose.
fn label<'a>(phrase: &str) -> Vec<Item<'a>> {
    phrase
        .split_whitespace()
        .map(|word| Item::Label(word.to_string()))
        .collect()
}
/// A cell with no text to speak.
fn is_empty_cell(cell: &Cell<'_>) -> bool {
    match cell {
        Cell::Lines(lines) => lines.is_empty(),
        Cell::Inline(events) => !events.iter().any(|(event, _)| {
            matches!(event, Event::Text(text) | Event::Code(text) if !text.trim().is_empty())
        }),
    }
}
/// Ranks punctuation marks: `?` and `!` above `.`, then `;`, `:` and `,`.
fn mark_strength(mark: char) -> u8 {
    match mark {
        '?' | '!' => 5,
        '.' => 4,
        ';' => 3,
        ':' => 2,
        ',' => 1,
        _ => 0,
    }
}
/// Replaces the run of punctuation that ends `word` (inside closing brackets and quotes) with
/// the single strongest mark of that run and a skipped token's `ending`, the first of equal
/// strength winning, and extends the word's range over the skipped token.
fn join_skipped_ending(word: &mut Piece, ending: &Piece) {
    word.range.end = ending.range.end;
    let end = word.text.trim_end_matches([')', ']', '}', '\'', '"']).len();
    let start = word.text[..end]
        .trim_end_matches(SENTENCE_PUNCTUATION)
        .len();
    let strongest = word.text[start..end]
        .chars()
        .chain(ending.text.chars())
        .reduce(|best, c| {
            if mark_strength(c) > mark_strength(best) {
                c
            } else {
                best
            }
        });
    if let Some(mark) = strongest {
        word.text
            .replace_range(start..end, mark.encode_utf8(&mut [0; 4]));
    }
    let len = word.text.len();
    for spoken in word.words.iter_mut().map(|w| &mut w.spoken) {
        *spoken = spoken.start.min(len)..spoken.end.min(len);
    }
    word.absorb(&ending.words);
}
/// An incremental Markdown preparation and chunking cursor.
pub struct TextCursor<'a> {
    source: &'a str,
    events: Box<dyn Iterator<Item = Item<'a>> + 'a>,
    /// The spoken items of the table being read, before the next item of `events`.
    table: VecDeque<Item<'a>>,
    /// The source range of the table row being read (see `Piece::row`).
    row: Option<Range<usize>>,
    pending: VecDeque<Piece>,
    fragment: Option<Fragment<'a>>,
    word: String,
    word_range: Option<Range<usize>>,
    word_code: Vec<Range<usize>>,
    read_code: bool,
    in_code: bool,
    skip_depth: usize,
    index: usize,
    chunk_limit: usize,
    byte_cursor: usize,
    utf16_cursor: u32,
    emoji: Regex,
    version: Regex,
    vocabulary: Option<Arc<Vocabulary>>,
    technical: TechnicalOptions,
    resume_byte: usize,
    /// Skipped words with no spoken word before them, waiting for the next spoken piece.
    orphans: Vec<Word>,
    span_byte: usize,
    span_utf16: u32,
    /// The last range `source_range` converted and its offsets.
    last_range: Option<(Range<usize>, (u32, u32))>,
    #[cfg(test)]
    work_units: usize,
    #[cfg(test)]
    html_scan_bytes: usize,
    #[cfg(test)]
    event_reads: std::rc::Rc<std::cell::Cell<usize>>,
}
impl<'a> TextCursor<'a> {
    /// Creates a cursor with the streaming request budget.
    pub fn streaming(source: &'a str, read_code: bool) -> Result<Self, TextError> {
        Self::streaming_with(source, read_code, None, TechnicalOptions::default())
    }
    /// Creates a streaming cursor that reads technical tokens with `vocabulary` when one is
    /// given (technical reading on); `None` prepares text exactly as `streaming` always has.
    /// `technical` chooses full or short paths and links.
    pub fn streaming_with(
        source: &'a str,
        read_code: bool,
        vocabulary: Option<Arc<Vocabulary>>,
        technical: TechnicalOptions,
    ) -> Result<Self, TextError> {
        let mut cursor = Self::new(source, read_code)?;
        cursor.set_chunk_limit(STREAMING_CHUNK_CHARS);
        cursor.vocabulary = vocabulary;
        cursor.technical = technical;
        Ok(cursor)
    }
    /// Creates a cursor that reads or skips fenced code blocks.
    pub fn new(source: &'a str, read_code: bool) -> Result<Self, TextError> {
        let emoji = Regex::new(
            r"[0-9#*]\x{FE0F}?\x{20E3}|[\p{Extended_Pictographic}\p{Regional_Indicator}\x{1F3FB}-\x{1F3FF}\x{FE0E}\x{FE0F}\x{200D}\x{20E3}]",
        )?;
        let version = Regex::new(r"\bv([0-9]+\.[0-9]+\.[0-9]+)")?;
        Ok(Self::with_events(
            source,
            read_code,
            source_items(source, document_events(source)),
            emoji,
            version,
        ))
    }
    /// A cursor over `events` (ranges into `source`) with the compiled normalizer patterns.
    fn with_events(
        source: &'a str,
        read_code: bool,
        events: impl Iterator<Item = Item<'a>> + 'a,
        emoji: Regex,
        version: Regex,
    ) -> Self {
        #[cfg(test)]
        let event_reads = std::rc::Rc::new(std::cell::Cell::new(0));
        #[cfg(test)]
        let events = events.inspect({
            let reads = event_reads.clone();
            move |_| reads.set(reads.get() + 1)
        });
        Self {
            source,
            events: Box::new(events),
            pending: VecDeque::new(),
            table: VecDeque::new(),
            row: None,
            fragment: None,
            word: String::new(),
            word_range: None,
            word_code: Vec::new(),
            read_code,
            in_code: false,
            skip_depth: 0,
            index: 0,
            chunk_limit: 300,
            byte_cursor: 0,
            utf16_cursor: 0,
            emoji,
            version,
            vocabulary: None,
            technical: TechnicalOptions::default(),
            resume_byte: 0,
            orphans: Vec::new(),
            span_byte: 0,
            span_utf16: 0,
            last_range: None,
            #[cfg(test)]
            work_units: 0,
            #[cfg(test)]
            html_scan_bytes: 0,
            #[cfg(test)]
            event_reads,
        }
    }
    /// Resumes preparation at `source_start`, a UTF-16 source offset such as a chunk's
    /// `source_start`, numbering the first chunk `index`: words ending at or before the offset
    /// are dropped, so that chunk starts there. Markdown is still parsed from the beginning, so
    /// its context and every source offset stay those of the whole source. Call before the
    /// first `next_chunk`.
    pub fn resume_at(&mut self, source_start: u32, index: usize) {
        self.index = index;
        let mut units = 0_u32;
        self.resume_byte = self.source.len();
        for (byte, c) in self.source.char_indices() {
            if units >= source_start {
                self.resume_byte = byte;
                break;
            }
            units += if c.len_utf16() == 2 { 2 } else { 1 };
        }
    }
    /// Lowers the later-chunk ceiling without changing the first chunk or word boundaries.
    pub fn set_chunk_limit(&mut self, limit: usize) {
        self.chunk_limit = limit.clamp(70, 300);
    }
    fn normalize(&self, word: &str, code: &[Range<usize>]) -> String {
        let raw_word = word;
        let stripped = self.emoji.replace_all(word, "");
        let word = stripped.as_ref();
        let bare = word.trim_matches(['(', ')', '[', ']', '{', '}', '\'', '"']);
        let bare = bare.trim_end_matches(['.', ',', ';', ':', '!', '?']);
        let bare = bare.trim_matches(['(', ')', '[', ']', '{', '}', '\'', '"']);
        let ending = word
            .trim_end_matches([')', ']', '}', '\'', '"'])
            .chars()
            .last()
            .filter(|c| matches!(c, '.' | ',' | ';' | ':' | '!' | '?'));
        if bare.starts_with("https://") || bare.starts_with("http://") {
            let host = bare
                .split_once("://")
                .map(|(_, s)| s.split(['/', '?', '#']).next().unwrap_or(""))
                .unwrap_or("");
            return format!(
                "link to {host}{}",
                ending.map(String::from).unwrap_or_default()
            );
        }
        let version = self.version.replace_all(word, "version $1");
        if version != word {
            return version.into_owned();
        }
        if word == "&" {
            return "and".into();
        }
        let tail = bare.rsplit('/').next().unwrap_or(bare);
        let extension = tail.rsplit_once('.').is_some_and(|(_, ext)| {
            !ext.is_empty() && ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric())
        });
        if ["/", "./", "../", "~/"].iter().any(|p| bare.starts_with(p))
            || (bare.contains('/') && extension)
        {
            return format!("{tail}{}", ending.map(String::from).unwrap_or_default());
        }
        let mut spoken = raw_word.to_string();
        for range in code.iter().rev() {
            if let Some(fragment) = spoken.get(range.clone()) {
                let normalized = fragment.replace(['_', '.'], " ");
                spoken.replace_range(range.clone(), &normalized);
            }
        }
        if spoken.contains('/') && !bare.chars().all(|c| c.is_ascii_digit() || c == '/') {
            spoken = spoken.replace('/', " ");
        }
        self.emoji.replace_all(&spoken, "").trim().to_string()
    }
    /// The technical reading of one word, when a vocabulary is set and the reading differs from
    /// the word; a word it leaves unchanged takes the ordinary path, so prose reads as before.
    fn technical_word(&self, word: &str) -> Option<String> {
        let vocabulary = self.vocabulary.as_deref()?;
        let word = self.emoji.replace_all(word, "");
        let spoken = speak_technical(&word, vocabulary, &self.technical);
        (spoken != word).then_some(spoken)
    }
    fn set_fragment(
        &mut self,
        value: pulldown_cmark::CowStr<'a>,
        range: Range<usize>,
        inline: bool,
    ) {
        let ptr = value.as_ptr() as usize;
        let source_ptr = self.source.as_ptr() as usize;
        let base = ptr.checked_sub(source_ptr).filter(|offset| {
            *offset <= self.source.len() && value.len() <= self.source.len() - *offset
        });
        self.fragment = Some(Fragment {
            value,
            range,
            offset: 0,
            base,
            inline,
            html: false,
            html_exhausted: false,
        });
    }
    /// The word being built as a piece, carrying the table row being read (see `Piece::row`).
    fn finish_word(&mut self) -> Option<Piece> {
        let mut piece = self.finished_word()?;
        piece.row.clone_from(&self.row);
        Some(piece)
    }
    fn finished_word(&mut self) -> Option<Piece> {
        let raw = std::mem::take(&mut self.word);
        let range = self.word_range.take()?;
        let code = std::mem::take(&mut self.word_code);
        let written = self.emoji.replace_all(&raw, "").into_owned();
        let text = match self.technical_word(&raw) {
            Some(spoken)
                if !spoken.is_empty()
                    && spoken.chars().all(|c| SENTENCE_PUNCTUATION.contains(&c)) =>
            {
                let mark = spoken
                    .chars()
                    .reduce(|best, c| {
                        if mark_strength(c) > mark_strength(best) {
                            c
                        } else {
                            best
                        }
                    })
                    .map(String::from)
                    .unwrap_or_default();
                return Some(Piece::word(mark, range, written, true));
            }
            Some(spoken) if spoken.trim().is_empty() => {
                return Some(Piece::word(String::new(), range, written, true));
            }
            Some(spoken) => spoken,
            None => self.normalize(&raw, &code),
        };
        if text.trim().is_empty() {
            None
        } else {
            Some(Piece::word(text, range, written, false))
        }
    }
    fn boundary(&mut self, range: Range<usize>, pause: u32) -> Option<Piece> {
        self.close_with(Piece::marker(String::new(), range, pause))
    }
    /// Returns the word being built, if any, with `marker` queued after it; else `marker`.
    fn close_with(&mut self, marker: Piece) -> Option<Piece> {
        if let Some(word) = self.finish_word() {
            self.pending.push_back(marker);
            Some(word)
        } else {
            Some(marker)
        }
    }
    fn tag_separates_words(&self, tag: &str, source_end: usize) -> bool {
        let name = tag
            .trim_start_matches('<')
            .trim_start_matches('/')
            .split(|c: char| c.is_whitespace() || c == '/' || c == '>')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if matches!(name.as_str(), "br" | "p" | "div" | "li") {
            return true;
        }
        if matches!(
            name.as_str(),
            "b" | "i"
                | "em"
                | "span"
                | "strong"
                | "u"
                | "s"
                | "small"
                | "sup"
                | "sub"
                | "code"
                | "mark"
                | "del"
                | "ins"
        ) {
            return false;
        }
        let word_character = |c: char| c.is_alphanumeric() || c == '_';
        self.word.chars().last().is_some_and(word_character)
            && self
                .source
                .get(source_end..)
                .and_then(|text| text.chars().next())
                .is_some_and(word_character)
    }
    /// A header cell read through the word pipeline as plain text, never parsed as Markdown
    /// (a `#` stays a word), with its trailing punctuation dropped.
    fn plain_text(&self, cell: &Cell<'a>) -> String {
        let mut cursor = TextCursor::with_events(
            self.source,
            false,
            cell_items(self.source, cell.clone()).into_iter(),
            self.emoji.clone(),
            self.version.clone(),
        );
        cursor.vocabulary.clone_from(&self.vocabulary);
        cursor.technical = self.technical;
        let words: Vec<String> = std::iter::from_fn(|| cursor.spoken_piece())
            .filter(|piece| !piece.text.is_empty())
            .map(|piece| piece.text)
            .collect();
        words
            .join(" ")
            .trim_end_matches(SENTENCE_PUNCTUATION)
            .to_string()
    }
    /// Queues the spoken items of a table block in the cursor's `TableStyle`: the opening
    /// sentence, the column names once (names once, with a header), every row, and the closing
    /// sentence. The opening carries the lines up to the header's end (no header: the first
    /// line), each row its own lines and the closing sentence the last row to the block's end.
    fn speak_table(&mut self, block: Range<usize>, table: Table<'a>) {
        let style = self.technical.tables;
        let names: Vec<String> = (0..table.columns)
            .map(|k| {
                table
                    .header
                    .as_ref()
                    .map(|header| self.plain_text(&header.cells[k]))
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| tables::column_name(k + 1))
            })
            .collect();
        let opening_end = match &table.header {
            Some(header) => header.range.end,
            None => {
                let lines = &self.source[block.clone()];
                lines.find('\n').map_or(block.end, |end| {
                    block.start + lines[..end].trim_end_matches('\r').len()
                })
            }
        };
        let closing_start = table
            .rows
            .last()
            .or(table.header.as_ref())
            .map_or(block.start, |row| row.range.start);
        let mut items = vec![Item::Row(Some(block.start..opening_end))];
        items.extend(label(&tables::intro(table.columns, table.rows.len())));
        items.push(Item::End(250, None));
        if style == TableStyle::NamesOnce && table.header.is_some() {
            items.extend(label(&tables::columns_sentence(&names)));
            items.push(Item::End(250, None));
        }
        for (n, row) in table.rows.into_iter().enumerate() {
            items.push(Item::Row(Some(row.range)));
            items.extend(label(&tables::row_label(n + 1, style)));
            let last = row.cells.len().saturating_sub(1);
            for (k, cell) in row.cells.into_iter().enumerate() {
                let empty = is_empty_cell(&cell);
                match style {
                    TableStyle::NameEach if empty => continue,
                    TableStyle::NameEach => {
                        items.extend(label(&format!("{}:", names[k])));
                        items.extend(cell_items(self.source, cell));
                        items.push(Item::End(100, Some('.')));
                    }
                    TableStyle::NamesOnce => {
                        if empty {
                            items.extend(label(tables::BLANK));
                        } else {
                            items.extend(cell_items(self.source, cell));
                        }
                        items.push(Item::End(100, Some(if k == last { '.' } else { ';' })));
                    }
                }
            }
            items.push(Item::End(250, None));
        }
        items.push(Item::Row(Some(closing_start..block.end)));
        items.extend(label(tables::END));
        items.extend([Item::End(450, None), Item::Row(None)]);
        self.table.extend(items);
    }
    fn piece(&mut self) -> Option<Piece> {
        loop {
            if let Some(p) = self.pending.pop_front() {
                return Some(p);
            }
            if let Some(mut f) = self.fragment.take()
                && let Some(ch) = f.value[f.offset..].chars().next()
            {
                #[cfg(test)]
                {
                    self.work_units += 1;
                }
                let start = f.offset;
                f.offset += ch.len_utf8();
                if f.html
                    && ch == '<'
                    && !f.html_exhausted
                    && let Some(end) = {
                        #[cfg(test)]
                        {
                            self.html_scan_bytes += f.value[f.offset..]
                                .find('>')
                                .map_or(f.value.len() - f.offset, |end| end + 1);
                        }
                        let end = f.value[f.offset..].find('>');
                        f.html_exhausted = end.is_none();
                        end
                    }
                {
                    let tag = &f.value[f.offset..f.offset + end];
                    let source_end = f
                        .base
                        .map(|base| base + f.offset + end + 1)
                        .unwrap_or(f.range.end);
                    let separates = self.tag_separates_words(tag, source_end);
                    f.offset += end + 1;
                    self.fragment = Some(f);
                    if separates && let Some(word) = self.finish_word() {
                        return Some(word);
                    }
                    continue;
                }
                let mut atom = ch.to_string();
                if f.html
                    && ch == '&'
                    && let Some((end, _)) = f.value[start..]
                        .char_indices()
                        .take(32)
                        .find(|(_, c)| *c == ';')
                {
                    let raw = &f.value[start..start + end + 1];
                    atom = Parser::new(raw)
                        .filter_map(|event| match event {
                            Event::Text(t) => Some(t.into_string()),
                            _ => None,
                        })
                        .collect::<String>();
                    f.offset = start + end + 1;
                    #[cfg(test)]
                    {
                        self.work_units += raw.chars().count() - 1;
                    }
                }
                // A box-drawing character ends the word and is dropped like a space: border and
                // tree characters carry no words and are never spoken.
                if atom.chars().all(|c| c.is_whitespace() || tables::is_box(c)) {
                    self.fragment = Some(f);
                    if let Some(p) = self.finish_word() {
                        return Some(p);
                    }
                    continue;
                }
                let mapped = f
                    .base
                    .map(|b| b + start..b + f.offset)
                    .unwrap_or_else(|| f.range.clone());
                self.word_range = Some(match self.word_range.take() {
                    Some(r) => r.start..mapped.end,
                    None => mapped,
                });
                if f.inline {
                    let offset = self.word.len();
                    if let Some(last) = self.word_code.last_mut().filter(|r| r.end == offset) {
                        last.end += atom.len();
                    } else {
                        self.word_code.push(offset..offset + atom.len());
                    }
                }
                self.word.push_str(&atom);
                self.fragment = Some(f);
                continue;
            }
            let item = match self.table.pop_front() {
                Some(item) => item,
                None => match self.events.next() {
                    Some(item) => item,
                    None => return self.finish_word(),
                },
            };
            let (event, range) = match item {
                Item::Event(event, range) => (event, range),
                Item::BlockStart(at, pause) => {
                    return self.boundary(at..at, pause);
                }
                Item::Table(block, table) => {
                    self.speak_table(block, table);
                    continue;
                }
                Item::Row(row) => {
                    self.row = row;
                    continue;
                }
                Item::Label(text) => {
                    let label = Piece::label(text, self.row.clone().unwrap_or_default());
                    return self.close_with(label);
                }
                Item::End(pause, mark) => {
                    let row = self.row.clone().unwrap_or_default();
                    let marker = Piece {
                        row: Some(row.clone()),
                        mark,
                        ..Piece::marker(String::new(), row, pause)
                    };
                    return self.close_with(marker);
                }
            };
            if self.skip_depth > 0 {
                match event {
                    Event::Start(_) => self.skip_depth += 1,
                    Event::End(end) => {
                        self.skip_depth -= 1;
                        if self.skip_depth == 0 && end == TagEnd::CodeBlock {
                            self.in_code = false;
                        }
                    }
                    _ => {}
                }
                continue;
            }
            match event {
                Event::Start(Tag::FootnoteDefinition(_)) => self.skip_depth = 1,
                Event::Start(Tag::Item) => {
                    if !self.word.is_empty() {
                        return self.boundary(range, 250);
                    }
                }
                Event::Start(
                    Tag::Paragraph
                    | Tag::Heading { .. }
                    | Tag::TableCell
                    | Tag::CodeBlock(CodeBlockKind::Indented),
                ) => {
                    if let Some(word) = self.finish_word() {
                        return Some(word);
                    }
                }
                Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(_))) => {
                    self.in_code = true;
                    if !self.read_code {
                        self.skip_depth = 1;
                        self.pending.push_back(Piece::word(
                            "code block skipped.".into(),
                            range.clone(),
                            String::new(),
                            false,
                        ));
                        self.pending
                            .push_back(Piece::marker(String::new(), range, 250));
                        if let Some(word) = self.finish_word() {
                            return Some(word);
                        }
                    }
                }
                Event::End(TagEnd::CodeBlock) => {
                    self.in_code = false;
                    return self.boundary(range, 250);
                }
                Event::Text(t) => self.set_fragment(t, range, self.in_code),
                Event::Code(t) => self.set_fragment(t, range, true),
                Event::End(TagEnd::Heading(_)) => return self.boundary(range, 600),
                Event::End(TagEnd::HtmlBlock) => return self.boundary(range, 450),
                Event::End(TagEnd::Item) => return self.boundary(range, 300),
                Event::End(TagEnd::Paragraph) => return self.boundary(range, 450),
                Event::End(TagEnd::TableCell) => return self.boundary(range, 100),
                Event::End(TagEnd::TableHead | TagEnd::TableRow) => {
                    return self.boundary(range, 250);
                }
                Event::HardBreak | Event::SoftBreak => {
                    if let Some(p) = self.finish_word() {
                        return Some(p);
                    }
                }
                Event::Html(t) => {
                    self.set_fragment(t, range, false);
                    if let Some(fragment) = self.fragment.as_mut() {
                        fragment.html = true;
                    }
                }
                Event::InlineHtml(tag) => {
                    if self.tag_separates_words(&tag, range.end)
                        && let Some(word) = self.finish_word()
                    {
                        return Some(word);
                    }
                }
                Event::FootnoteReference(_) => {}
                _ => {}
            }
        }
    }
    /// The next piece with skipped endings settled: a spoken word takes the marks of the skipped
    /// tokens right after it (see `join_skipped_ending`), up to the next spoken word or boundary
    /// marker, and a skipped ending with nothing spoken before it in its run is dropped.
    ///
    /// A table cell's skipped words stay with that cell: a label never takes the skipped words
    /// after it, and a cell that spoke no word keeps them at its end: in a "blank" piece when the
    /// names are read once, else on the cell's closing marker, so they end the chunk holding the
    /// cell's label. Wrapped cells are read column by column, so the next cell can start earlier
    /// in the source; carried over to it, these spans would break the chunk's source order.
    fn spoken_piece(&mut self) -> Option<Piece> {
        loop {
            let mut piece = self.piece()?;
            if piece.skipped {
                self.orphans.append(&mut piece.words);
                continue;
            }
            if piece.text.is_empty() {
                if piece.mark.is_some() && !self.orphans.is_empty() {
                    let skipped = std::mem::take(&mut self.orphans);
                    if self.technical.tables == TableStyle::NamesOnce {
                        let mut blank = Piece::label(tables::BLANK.into(), piece.span().clone());
                        blank.words = skipped;
                        self.pending.push_front(piece);
                        return Some(blank);
                    }
                    piece.words = skipped;
                }
                return Some(piece);
            }
            let label = piece.row.is_some() && piece.words.is_empty();
            piece.words.splice(0..0, std::mem::take(&mut self.orphans));
            if self.vocabulary.is_none() || label {
                return Some(piece);
            }
            while let Some(next) = self.piece() {
                if !next.skipped {
                    self.pending.push_front(next);
                    break;
                }
                if next.text.is_empty() {
                    piece.absorb(&next.words);
                } else {
                    join_skipped_ending(&mut piece, &next);
                }
            }
            return Some(piece);
        }
    }
    fn structural_pause(&mut self, mut pause: u32) -> (u32, bool) {
        let mut synthetic_period = pause >= 250;
        let mut immediate_marker = true;
        while let Some(next) = self.spoken_piece() {
            if !next.text.is_empty() {
                self.pending.push_front(next);
                break;
            }
            if immediate_marker && pause == 100 && next.pause >= 250 {
                synthetic_period = true;
            }
            immediate_marker = false;
            pause = pause.max(next.pause);
        }
        (pause, synthetic_period)
    }
    /// Where an over-long first piece is cut: at `cut`, the character limit, or with technical
    /// reading on, at the last space before it so no spoken word is split. Returns the end of
    /// the kept text and the start of the remainder.
    fn spoken_word_cut(&self, text: &str, cut: usize) -> (usize, usize) {
        if self.vocabulary.is_none() {
            return (cut, cut);
        }
        let window = cut + text[cut..].chars().next().map_or(0, char::len_utf8);
        match text[..window].rfind(' ') {
            Some(space) if space > 0 => (space, space + 1),
            _ => (cut, cut),
        }
    }
    /// With technical reading on, moves the proportional source cut of a split piece to the
    /// nearest point just after a separator such as `/`, `.` or `_`, so each part's highlight
    /// ends between source segments instead of inside one.
    fn source_cut_near(&self, source: &str, proportional: usize) -> usize {
        if self.vocabulary.is_none() {
            return proportional;
        }
        source
            .char_indices()
            .filter(|(_, c)| !c.is_alphanumeric())
            .map(|(index, c)| index + c.len_utf8())
            .filter(|end| *end < source.len())
            .min_by_key(|end| end.abs_diff(proportional))
            .unwrap_or(proportional)
    }
    /// The UTF-16 offsets of a chunk's byte range, counted on from the last chunk: a range
    /// starting before the last one ended starts where it ended, except that the same range again
    /// (the chunks of one table row) gets the same offsets.
    fn source_range(&mut self, range: Range<usize>) -> Result<(u32, u32), TextError> {
        if let Some((last, offsets)) = &self.last_range
            && *last == range
        {
            return Ok(*offsets);
        }
        let start = range.start.max(self.byte_cursor);
        self.utf16_cursor = self
            .utf16_cursor
            .checked_add(
                u32::try_from(self.source[self.byte_cursor..start].encode_utf16().count())
                    .map_err(|_| TextError::Range)?,
            )
            .ok_or(TextError::Range)?;
        let start_char = self.utf16_cursor;
        let end = range.end.max(start);
        self.utf16_cursor = self
            .utf16_cursor
            .checked_add(
                u32::try_from(self.source[start..end].encode_utf16().count())
                    .map_err(|_| TextError::Range)?,
            )
            .ok_or(TextError::Range)?;
        self.byte_cursor = end;
        let offsets = (start_char, self.utf16_cursor);
        self.last_range = Some((range, offsets));
        Ok(offsets)
    }
    /// The UTF-16 offset of source byte `byte`, counted on from the last offset asked for.
    fn utf16_offset(&mut self, byte: usize) -> Result<u32, TextError> {
        if byte >= self.span_byte {
            let gap = self
                .source
                .get(self.span_byte..byte)
                .ok_or(TextError::Range)?;
            self.span_utf16 = self
                .span_utf16
                .checked_add(utf16_len(gap)?)
                .ok_or(TextError::Range)?;
            self.span_byte = byte;
            Ok(self.span_utf16)
        } else {
            let back = self
                .source
                .get(byte..self.span_byte)
                .ok_or(TextError::Range)?;
            self.span_utf16
                .checked_sub(utf16_len(back)?)
                .ok_or(TextError::Range)
        }
    }
    /// Prepares the next spoken chunk, returning None at the end of the source.
    pub fn next_chunk(&mut self) -> Result<Option<TextChunk>, TextError> {
        Ok(self.next_written_chunk()?.map(|(aligned, _)| aligned.chunk))
    }
    /// Prepares the next spoken chunk with the span of every written word it speaks.
    pub fn next_aligned_chunk(&mut self) -> Result<Option<AlignedChunk>, TextError> {
        Ok(self.next_written_chunk()?.map(|(aligned, _)| aligned))
    }
    /// The next chunk and its word spans, with the word each span was read from as written. A
    /// skipped token's punctuation has already joined the word before it (see `spoken_piece`),
    /// so it chunks and pauses as if written on that word.
    pub(crate) fn next_written_chunk(
        &mut self,
    ) -> Result<Option<(AlignedChunk, Vec<String>)>, TextError> {
        let limit = if self.index == 0 {
            70
        } else {
            self.chunk_limit
        };
        let mut words: Vec<Piece> = Vec::new();
        let mut size = 0;
        let mut pause = 0;
        let mut synthetic_period = false;
        let mut mark = None;
        // Skipped words that end the chunk: those of a table cell that spoke none.
        let mut ending = Vec::new();
        let mut boundary = None;
        while let Some(mut p) = self.spoken_piece() {
            if self.resume_byte > 0 && p.span().end <= self.resume_byte {
                continue;
            }
            if p.text.is_empty() {
                if words.is_empty() {
                    self.orphans.append(&mut p.words);
                    continue;
                }
                ending = std::mem::take(&mut p.words);
                (pause, synthetic_period) = self.structural_pause(p.pause);
                mark = p.mark;
                break;
            }
            if words.is_empty() && p.text.chars().count() > limit {
                let cut = p
                    .text
                    .char_indices()
                    .nth(limit - 1)
                    .map(|(i, _)| i)
                    .ok_or(TextError::Range)?;
                let source = &self.source[p.range.clone()];
                let source_count = source.chars().count();
                let spoken_count = p.text.chars().count();
                let (cut, resume) = self.spoken_word_cut(&p.text, cut);
                let source_cut = if source == p.text {
                    cut
                } else {
                    let count =
                        (p.text[..cut].chars().count() * source_count / spoken_count).max(1);
                    let proportional = source
                        .char_indices()
                        .nth(count)
                        .map_or(source.len(), |(i, _)| i);
                    self.source_cut_near(source, proportional)
                };
                let (kept, rest) = split_words(
                    std::mem::take(&mut p.words),
                    cut,
                    resume,
                    p.range.start + source_cut,
                );
                p.words = kept;
                let remainder = Piece {
                    text: p.text[resume..].to_owned(),
                    range: p.range.start + source_cut..p.range.end,
                    pause: p.pause,
                    skipped: false,
                    words: rest,
                    row: p.row.clone(),
                    mark: None,
                };
                p.text.truncate(cut);
                p.range.end = remainder.range.start;
                p.pause = 0;
                self.pending.push_front(remainder);
                words.push(p);
                break;
            }
            let added = p.text.chars().count() + usize::from(!words.is_empty());
            if !words.is_empty() && size + added > limit {
                self.pending.push_front(p);
                if let Some(cut) = boundary {
                    for extra in words.drain(cut..).rev() {
                        self.pending.push_front(extra);
                    }
                } else if self.index > 0
                    && let Some(cut) = words.iter().rposition(|w| w.text.ends_with([',', ';']))
                {
                    for extra in words.drain(cut + 1..).rev() {
                        self.pending.push_front(extra);
                    }
                }
                break;
            }
            size += added;
            let ending = p.text.trim_end_matches([')', ']', '}', '\'', '"']);
            let end_sentence = ending.ends_with(['.', '!', '?']);
            let natural = ending.ends_with(['.', '!', '?', ',', ';', ':']);
            words.push(p);
            if end_sentence {
                boundary = Some(words.len());
            }
            if self.index == 0 && natural && size >= 40 {
                (pause, synthetic_period) = self.structural_pause(0);
                break;
            }
        }
        if words.is_empty() {
            return Ok(None);
        }
        let range = words[0].span().start..words.last().ok_or(TextError::Range)?.span().end;
        let mut spans = Vec::new();
        let mut written = Vec::new();
        let mut offset = 0_u32;
        for piece in &words {
            for word in &piece.words {
                if self.resume_byte > 0
                    && word.spoken.is_empty()
                    && word.source.end <= self.resume_byte
                {
                    continue;
                }
                let spoken_units = |end: usize| {
                    let before = piece.text.get(..end).ok_or(TextError::Range)?;
                    offset
                        .checked_add(utf16_len(before)?)
                        .ok_or(TextError::Range)
                };
                spans.push(WordSpan {
                    source_start: self.utf16_offset(word.source.start)?,
                    source_end: self.utf16_offset(word.source.end)?,
                    spoken_start: spoken_units(word.spoken.start)?,
                    spoken_end: spoken_units(word.spoken.end)?,
                });
                written.push(word.written.clone());
            }
            offset = offset
                .checked_add(utf16_len(&piece.text)? + 1)
                .ok_or(TextError::Range)?;
        }
        // Skipped words still waiting here have no spoken word after them: the source has ended.
        let end = offset.saturating_sub(1);
        for word in ending.into_iter().chain(std::mem::take(&mut self.orphans)) {
            if self.resume_byte > 0 && word.source.end <= self.resume_byte {
                continue;
            }
            spans.push(WordSpan {
                source_start: self.utf16_offset(word.source.start)?,
                source_end: self.utf16_offset(word.source.end)?,
                spoken_start: end,
                spoken_end: end,
            });
            written.push(word.written);
        }
        let mut text = words
            .into_iter()
            .map(|w| w.text)
            .collect::<Vec<_>>()
            .join(" ");
        let ends_in_mark = |text: &str| {
            text.trim_end_matches([')', ']', '}', '\'', '"'])
                .ends_with(['.', '!', '?', ':', ',', ';'])
        };
        // A table value's mark is spoken punctuation: it adds its pause like a written one.
        if let Some(mark) = mark
            && !ends_in_mark(&text)
        {
            text.push(mark);
        }
        let ending = text.trim_end_matches([')', ']', '}', '\'', '"']);
        let punctuation_pause = if ending.ends_with(['.', '!', '?']) {
            280
        } else if ending.ends_with([',', ';', ':']) {
            120
        } else {
            0
        };
        pause = pause.max(punctuation_pause);
        if synthetic_period && !ends_in_mark(&text) {
            text.push('.');
        }
        let (source_start, source_end) = self.source_range(range)?;
        let chunk = TextChunk {
            index: self.index,
            text,
            source_start,
            source_end,
            pause_ms: pause,
        };
        self.index += 1;
        Ok(Some((
            AlignedChunk {
                chunk,
                words: spans,
            },
            written,
        )))
    }
}
/// The length of `text` in UTF-16 units.
fn utf16_len(text: &str) -> Result<u32, TextError> {
    u32::try_from(text.encode_utf16().count()).map_err(|_| TextError::Range)
}
/// Divides a split piece's words between the kept text (bytes before `cut`) and the remainder
/// (bytes from `resume`, renumbered from 0); a word across the cut gets a part on each side,
/// its source divided at `source_cut`.
fn split_words(
    words: Vec<Word>,
    cut: usize,
    resume: usize,
    source_cut: usize,
) -> (Vec<Word>, Vec<Word>) {
    let mut kept = Vec::new();
    let mut rest = Vec::new();
    for word in words {
        let middle = source_cut.clamp(word.source.start, word.source.end);
        let renumbered = |at: usize| at.saturating_sub(resume);
        if word.spoken.end <= cut {
            kept.push(word);
        } else if word.spoken.start >= resume {
            let spoken = renumbered(word.spoken.start)..renumbered(word.spoken.end);
            rest.push(Word { spoken, ..word });
        } else {
            kept.push(Word {
                source: word.source.start..middle,
                written: word.written.clone(),
                spoken: word.spoken.start..cut,
            });
            rest.push(Word {
                source: middle..word.source.end,
                spoken: 0..renumbered(word.spoken.end),
                ..word
            });
        }
    }
    (kept, rest)
}
#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn prepared(source: &str, code: bool) -> String {
        let mut cursor = TextCursor::new(source, code).unwrap();
        let mut all = Vec::new();
        while let Some(chunk) = cursor.next_chunk().unwrap() {
            all.push(chunk.text);
        }
        all.join(" ")
    }
    #[test]
    fn wbfix_unbroken_words_are_bounded_with_exact_source_ranges_and_following_text() {
        for count in [400, 20_000] {
            for letter in ["x", "é"] {
                let word = letter.repeat(count);
                let source = format!("{word}\n\nFollowing text must be reached.");
                let mut cursor = TextCursor::streaming(&source, false).unwrap();
                let mut joined = String::new();
                let mut end = 0;
                while let Some(chunk) = cursor.next_chunk().unwrap() {
                    assert!(
                        chunk.text.chars().count() <= 100,
                        "synthesis text budget exceeded"
                    );
                    if chunk.source_start < word.encode_utf16().count() as u32 {
                        assert_eq!(chunk.source_start, end);
                        let original: String = source
                            .encode_utf16()
                            .skip(chunk.source_start as usize)
                            .take((chunk.source_end - chunk.source_start) as usize)
                            .map(|unit| char::from_u32(u32::from(unit)).unwrap())
                            .collect();
                        assert_eq!(chunk.text.trim_end_matches('.'), original);
                        joined.push_str(&original);
                    } else {
                        assert_eq!(chunk.text, "Following text must be reached.");
                    }
                    end = chunk.source_end;
                }
                assert_eq!(joined, word);
                assert_eq!(end as usize, source.encode_utf16().count());
            }
        }
    }
    #[test]
    fn section_four_markdown_rules_have_golden_outputs() {
        let source = "# Heading\n\n- **first** item\n- second [label](https://example.com/path)\n\n`foo_bar.rs` and v0.9.7 at /a/b/file.rs.\n\nhttps://example.org/path ![Picture](img.png) <b>hello</b> 😀 note[^1]\n\n```rust\nsecret();\n```\n\n| Name | Value |\n| --- | --- |\n| A | 42 |\n\n[^1]: omit footnote\n";
        let result = prepared(source, false);
        assert!(result.contains("first item."));
        assert!(result.contains("second label."));
        assert!(result.contains("foo bar rs"));
        assert!(result.contains("version 0.9.7"));
        assert!(result.contains("file.rs."));
        assert!(result.contains("link to example.org"));
        assert!(result.contains("Picture"));
        assert!(!result.contains("😀"));
        assert!(result.contains("code block skipped."));
        assert!(!result.contains("secret"));
        assert!(!result.contains("omit footnote"));
        assert!(prepared("```\nfoo_bar.rs\n```", true).contains("foo bar rs"));
    }
    #[test]
    fn bounded_words_and_long_word_parts_keep_utf16_ranges_for_highlighting() {
        let source = "Reading clearly, one phrase at a time. This second sentence contains naïve names and remains bounded.";
        let mut cursor = TextCursor::new(source, false).unwrap();
        let mut last = 0;
        while let Some(chunk) = cursor.next_chunk().unwrap() {
            assert!(chunk.source_start >= last);
            assert!(chunk.source_end > chunk.source_start);
            assert!(chunk.source_end <= source.encode_utf16().count() as u32);
            last = chunk.source_end;
        }
        let unicode = "😀 naïve readers enjoy clear sentences.";
        let mut cursor = TextCursor::new(unicode, false).unwrap();
        let chunk = cursor.next_chunk().unwrap().unwrap();
        assert_eq!(chunk.source_start, 3);
        assert_eq!(chunk.source_end, unicode.encode_utf16().count() as u32);
        assert_eq!(chunk.text, "naïve readers enjoy clear sentences.");
        let word = "x".repeat(400);
        assert_eq!(prepared(&word, false).replace(' ', ""), format!("{word}."));
    }
}

#[cfg(test)]
mod bakeoff_goldens {
    use super::*;
    #[test]
    fn all_seven_bakeoff_inputs_match_reviewed_preparation_and_chunks() {
        let cases: std::collections::BTreeMap<String, Vec<String>> =
            serde_json::from_str(include_str!("../tests/fixtures/text/goldens.json")).unwrap();
        assert_eq!(cases.len(), 7);
        for (name, expected) in cases {
            let source = std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fixtures/text")
                    .join(&name),
            )
            .unwrap();
            let mut cursor = TextCursor::new(&source, false).unwrap();
            let mut output = Vec::new();
            while let Some(chunk) = cursor.next_chunk().unwrap() {
                output.push(chunk.text);
            }
            assert_eq!(output, expected, "{name}");
        }
    }
}
#[cfg(test)]
mod fixes {
    use super::*;
    #[test]
    fn smaller_chunks_preserve_prepared_words_ranges_and_structural_pauses() {
        let source = format!(
            "# A heading\n\n{}\n\nA final paragraph.",
            "These ordinary words stay in their original order. ".repeat(12)
        );
        let mut cursor = TextCursor::new(&source, false).unwrap();
        cursor.set_chunk_limit(100);
        let mut output = Vec::new();
        while let Some(chunk) = cursor.next_chunk().unwrap() {
            assert!(chunk.text.chars().count() <= 101);
            assert!(chunk.source_start < chunk.source_end);
            if let Some(previous) = output.last() {
                let previous: &TextChunk = previous;
                assert!(previous.source_end <= chunk.source_start);
            }
            output.push(chunk);
        }
        assert_eq!(output[0].pause_ms, 600);
        assert_eq!(output.last().unwrap().pause_ms, 450);
        assert_eq!(
            output
                .iter()
                .flat_map(|c| c.text.split_whitespace())
                .collect::<Vec<_>>(),
            chunks(&source)
                .iter()
                .flat_map(|c| c.text.split_whitespace())
                .collect::<Vec<_>>()
        );
    }
    fn chunks(s: &str) -> Vec<TextChunk> {
        let mut c = TextCursor::new(s, false).unwrap();
        std::iter::from_fn(|| c.next_chunk().unwrap()).collect()
    }
    fn spoken(s: &str) -> String {
        chunks(s)
            .into_iter()
            .map(|c| c.text)
            .collect::<Vec<_>>()
            .join(" ")
    }
    #[test]
    fn structural_pauses() {
        assert_eq!(chunks("# Heading")[0].pause_ms, 600);
        assert_eq!(chunks("Paragraph text.")[0].pause_ms, 450);
        let table = chunks("| Name | Value |\n| --- | --- |\n| A | 42 |\n");
        assert_eq!(
            table.iter().map(|c| c.pause_ms).collect::<Vec<_>>(),
            vec![280, 280, 280, 450]
        );
        assert_eq!(
            table.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(),
            vec![
                "Table, 2 columns, 1 row.",
                "Row 1. Name: A.",
                "Value: 42.",
                "End of table."
            ]
        );
    }
    #[test]
    fn block_quoted_table_keeps_cell_and_row_pauses() {
        let table = chunks("> | Name | Value |\n> | --- | --- |\n> | A | 42 |\n");
        assert_eq!(
            table.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(),
            vec!["Name", "Value.", "A", "42."]
        );
        assert_eq!(
            table.iter().map(|c| c.pause_ms).collect::<Vec<_>>(),
            vec![100, 250, 100, 250]
        );
    }
    #[test]
    fn empty_trailing_table_cells_preserve_chunk_text() {
        let source = "| Name | |\n| --- | --- |\n| A | |";
        let out = chunks(source);
        assert_eq!(
            out.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(),
            vec![
                "Table, 2 columns, 1 row.",
                "Row 1. Name: A.",
                "End of table."
            ]
        );
        let row = source.find("| A | |").unwrap();
        assert_eq!(
            (out[1].source_start, out[1].source_end),
            (row as u32, source.len() as u32)
        );
        assert_eq!(
            out.iter().map(|c| c.pause_ms).collect::<Vec<_>>(),
            vec![280, 280, 450]
        );
    }
    #[test]
    fn paragraph_pauses_inside_lists_keep_the_larger_boundary() {
        for source in [
            "- First paragraph.\n\n  Second paragraph.",
            "- First paragraph.\n\n- Second paragraph.",
        ] {
            let out = chunks(source);
            assert_eq!(
                out.iter().map(|c| c.pause_ms).collect::<Vec<_>>(),
                vec![450, 450]
            );
            for (chunk, expected) in out.iter().zip(["First paragraph.", "Second paragraph."]) {
                assert_eq!(chunk.text, expected);
                let start = source.find(expected).unwrap();
                assert_eq!(chunk.source_start, start as u32);
                assert_eq!(chunk.source_end, (start + expected.len()) as u32);
            }
        }
        assert_eq!(chunks("- Tight item.")[0].pause_ms, 300);
    }
    #[test]
    fn sentence_and_clause_pauses() {
        let out = chunks(
            "A first sentence with enough words to pass forty characters. Another sentence.",
        );
        assert_eq!(
            out.iter().map(|c| c.pause_ms).collect::<Vec<_>>(),
            vec![280, 450]
        );
        let source = format!(
            "# Start\n\n{}end, {}ends.",
            "word ".repeat(39),
            "word ".repeat(39)
        );
        assert_eq!(
            source.strip_prefix("# Start\n\n").unwrap().chars().count(),
            400
        );
        let out = chunks(&source);
        assert_eq!(out.len(), 3);
        assert!(out[1].text.ends_with(','));
        assert_eq!(out[1].pause_ms, 120);
        assert_eq!(out[2].pause_ms, 450);
        assert_eq!(chunks("- List item.")[0].pause_ms, 300);
        assert_eq!(chunks(&"word ".repeat(30))[0].pause_ms, 0);
        let quoted =
            chunks(r#""A quoted sentence with enough characters ends here." More follows."#);
        assert_eq!(quoted[0].pause_ms, 280);
    }
    #[test]
    fn hostile_html_scans_each_suffix_at_most_once() {
        let source = format!("<div>\n{}\n", "<".repeat(200_000));
        let mut cursor = TextCursor::streaming(&source, false).unwrap();
        assert!(cursor.next_chunk().unwrap().is_some());
        assert!(
            cursor.html_scan_bytes <= source.len(),
            "HTML scan inspected {} bytes for {} input bytes",
            cursor.html_scan_bytes,
            source.len()
        );
    }
    #[test]
    fn html_and_footnote_markers_are_dropped() {
        assert_eq!(
            spoken("<b>hello</b> note[^secret]\n\n[^secret]: hidden"),
            "hello note."
        );
        assert_eq!(
            spoken("<div>Read me &amp; you</div>\n\nEnd."),
            "Read me and you. End."
        );
    }
    #[test]
    fn removed_html_tags_separate_text_without_splitting_formatted_words() {
        for source in [
            "Line one<br>line two",
            "Line one<br/>line two",
            "Line one<BR />line two",
            "Line one</p><p>line two",
            "Line one<div>line two</div>",
            "Line one<li>line two</li>",
            "Line one<custom>line two",
            "Line one<br><br/>  line two",
            "<div>Line one<br/>line two</div>",
        ] {
            assert_eq!(spoken(source), "Line one line two.", "{source}");
        }
        for source in [
            "a<b>bold</b>word",
            "a<i>bold</i>word",
            "a<em>bold</em>word",
            "a<span>bold</span>word",
            "a<strong>bold</strong>word",
            "<div>a<b>bold</b>word</div>",
        ] {
            assert_eq!(spoken(source), "aboldword.", "{source}");
        }
        assert_eq!(spoken("two<span> </span>words"), "two words.");
        let table = chunks("| Words |\n| --- |\n| first<br>second |\n");
        assert_eq!(table[1].text, "Row 1. Words: first second.");
    }
    #[test]
    fn later_limit_and_sentence_boundaries() {
        let left = format!("{}ends", "word ".repeat(59));
        let right = format!("{}end", "word ".repeat(59));
        let sentence = format!("{left}, {right}.");
        assert_eq!(sentence.chars().count(), 600);
        let s = format!("# Start\n\n{sentence}");
        let out = chunks(&s);
        assert_eq!(out.len(), 3);
        assert!(out[1].text.ends_with(','));
        assert!(out.iter().all(|c| c.text.chars().count() <= 300));
        let normal = chunks(
            "# Start\n\nThen the deadline is October 12, 2026, at 18:45 UTC. Read it; remember it.",
        );
        assert_eq!(normal.len(), 2);
    }
    #[test]
    fn exact_utf16_ranges() {
        let s = "Naïve first sentence is long enough to pass forty chars. 😀😀 Ünïcödé second sentence follows here.";
        let out = chunks(s);
        let second = s.find("Ünïcödé").unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(
            (out[0].source_start, out[0].source_end),
            (
                0,
                s[..s.find(". ").unwrap() + 1].encode_utf16().count() as u32
            )
        );
        assert_eq!(
            out[1].source_start,
            s[..second].encode_utf16().count() as u32
        );
        assert_eq!(out[1].source_end, s.encode_utf16().count() as u32);
        let s = "<div>Naïve first sentence is long enough to pass forty chars. 😀😀 Ünïcödé &amp; second.</div>";
        let out = chunks(s);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].source_start, 5);
        assert_eq!(
            out[0].source_end,
            s[..s.find(". ").unwrap() + 1].encode_utf16().count() as u32
        );
        assert_eq!(
            out[1].source_start,
            s[..s.find("Ünïcödé").unwrap()].encode_utf16().count() as u32
        );
        assert_eq!(
            out[1].source_end,
            s[..s.find("</div>").unwrap()].encode_utf16().count() as u32
        );
        assert_eq!(out[1].text, "Ünïcödé and second.");
    }
    #[test]
    fn first_chunk_work_is_bounded_on_large_single_line() {
        let s = "A readable sentence of at least forty characters ends here. ".repeat(20000);
        let mut c = TextCursor::new(&s, false).unwrap();
        assert!(c.next_chunk().unwrap().is_some());
        assert!(c.work_units < 400, "{}", c.work_units);
        for _ in 0..200 {
            c.next_chunk().unwrap();
        }
        assert!(c.work_units < 65000, "{}", c.work_units);
    }
    #[test]
    fn first_chunk_prefers_punctuation_then_word_boundary() {
        let s =
            "First natural boundary has enough readable words here, and then we continue speaking.";
        let out = chunks(s);
        assert!(out[0].text.ends_with(','));
        assert!((40..=70).contains(&out[0].text.chars().count()));
        let s = r#""A quoted sentence with enough characters ends here." More follows."#;
        let out = chunks(s);
        assert!(out[0].text.ends_with(".\""));
        assert!(!out[1].text.ends_with(".\"."));
        let s = "words ".repeat(30);
        assert!(chunks(&s)[0].text.chars().count() <= 70);
        assert_eq!(chunks(&s)[0].text.split_whitespace().last(), Some("words"));
        assert_eq!(
            chunks("# Short\n\nA following paragraph.")[0].text,
            "Short."
        );
    }
    #[test]
    fn skipped_fence_does_not_change_following_prose() {
        assert_eq!(
            spoken("```\nsecret();\n```\n\n## 3.6 Footer\n\nGPU3/Vulkan and repo/model2."),
            "code block skipped. 3.6 Footer. GPU3 Vulkan and repo model2."
        );
        assert_eq!(
            spoken("<div>AT&amp;T &#65; &#x42; &euro;</div>"),
            "AT&T A B €."
        );
    }
    #[test]
    fn first_chunk_does_not_consume_document_events() {
        let s = "A readable sentence of at least forty characters ends here.\n\n".repeat(20000);
        let mut c = TextCursor::new(&s, false).unwrap();
        assert!(c.next_chunk().unwrap().is_some());
        assert!(c.event_reads.get() < 10, "{}", c.event_reads.get());
    }
    #[test]
    fn normalization_preserves_content() {
        let s = "Use and/or TCP/IP 24/7 10/01/2026 1/2 Diff/Side provider/model GPU/Vulkan /a/file.rs ./b.txt ../c.md ~/d.png a/b.rs.";
        assert_eq!(
            spoken(s),
            "Use and or TCP IP 24/7 10/01/2026 1/2 Diff Side provider model GPU Vulkan file.rs b.txt c.md d.png b.rs."
        );
        assert_eq!(
            spoken("Visit (https://example.com/a). Then \"https://example.org/b\"."),
            "Visit link to example.com. Then link to example.org."
        );
        assert_eq!(
            spoken("AT&amp;T foo*bar (v0.9.7) `v1.2.3`"),
            "AT&T foo*bar (version 0.9.7) version 1.2.3."
        );
        assert_eq!(
            spoken("Flags 🇺🇸 keycap 1️⃣ skin 👍🏽 family 👨‍👩‍👧‍👦 done."),
            "Flags keycap skin family done."
        );
        assert_eq!(
            spoken("Intro.\n\n    Indented prose here.\n"),
            "Intro. Indented prose here."
        );
        assert_eq!(
            spoken("words continue\nonto next line."),
            "words continue onto next line."
        );
    }
}
#[cfg(test)]
mod technical {
    use super::*;
    use crate::vocabulary::speak_technical;

    const OWNER_LINE: &str = "Cached files go here: tests/lib.sh has a cache_dir helper that returns notes/.cache/demo/.tests.";

    fn chunks_with(
        source: &str,
        vocabulary: Option<Arc<Vocabulary>>,
        options: TechnicalOptions,
    ) -> Vec<TextChunk> {
        let mut cursor = TextCursor::streaming_with(source, false, vocabulary, options).unwrap();
        std::iter::from_fn(|| cursor.next_chunk().unwrap()).collect()
    }
    fn technical_chunks(source: &str, options: TechnicalOptions) -> Vec<TextChunk> {
        chunks_with(
            source,
            Some(Arc::new(crate::vocabulary::rules_fixture())),
            options,
        )
    }
    fn joined(chunks: &[TextChunk]) -> String {
        chunks
            .iter()
            .map(|chunk| chunk.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }
    fn technical_text(source: &str) -> String {
        joined(&technical_chunks(source, TechnicalOptions::default()))
    }
    fn today(source: &str) -> Vec<TextChunk> {
        let mut cursor = TextCursor::streaming(source, false).unwrap();
        std::iter::from_fn(|| cursor.next_chunk().unwrap()).collect()
    }
    fn utf16(source: &str, byte: usize) -> u32 {
        source[..byte].encode_utf16().count() as u32
    }
    fn short_paths() -> TechnicalOptions {
        TechnicalOptions {
            full_paths: false,
            full_links: false,
            ..TechnicalOptions::default()
        }
    }

    #[test]
    fn technical_paragraph_reads_owner_examples() {
        assert_eq!(
            technical_text(OWNER_LINE),
            "Cached files go here: tests slash lib dot S H has a cache underscore dir helper that returns notes slash dot cache slash demo slash dot tests."
        );
        assert_eq!(
            technical_text("Run /review with --dry-run on every .sh file."),
            "Run slash review with dash dash dry dash run on every dot S H file."
        );
    }

    #[test]
    fn technical_off_is_unchanged() {
        let off = chunks_with(OWNER_LINE, None, TechnicalOptions::default());
        assert_eq!(off, today(OWNER_LINE));
        assert_eq!(
            joined(&off),
            "Cached files go here: lib.sh has a cache_dir helper that returns .tests."
        );
        let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/text");
        let cases: std::collections::BTreeMap<String, Vec<String>> =
            serde_json::from_str(include_str!("../tests/fixtures/text/goldens.json")).unwrap();
        for name in cases.keys() {
            let source = std::fs::read_to_string(fixtures.join(name)).unwrap();
            let expected = today(&source);
            for full_paths in [false, true] {
                for full_links in [false, true] {
                    let options = TechnicalOptions {
                        full_paths,
                        full_links,
                        ..TechnicalOptions::default()
                    };
                    assert_eq!(chunks_with(&source, None, options), expected, "{name}");
                }
            }
        }
    }

    #[test]
    fn technical_on_keeps_prose_as_today() {
        for source in [
            "Read me & you, then AT&amp;T and foo*bar.",
            "<div>Read me &amp; you</div>\n\nEnd.",
            "Then the deadline is October 12, 2026, at 18:45 today. Read it; remember it.",
            "For example e.g. the U.S. rate is 3.14 at 10:59, done.",
            "Flags 🇺🇸 keycap 1️⃣ skin 👍🏽 family 👨‍👩‍👧‍👦 done.",
            "Naïve first sentence is long enough to pass forty chars. 😀😀 Ünïcödé second sentence follows here.",
        ] {
            assert_eq!(
                technical_chunks(source, TechnicalOptions::default()),
                today(source),
                "{source}"
            );
        }
    }

    #[test]
    fn technical_highlight_covers_source_token() {
        let source =
            "Café notes 😀 here.\n\n**tests/lib.sh**\n\n(/review),\n\nNaïve `fixture_base` text.";
        let out = technical_chunks(source, TechnicalOptions::default());
        let chunk = |text: &str| out.iter().find(|chunk| chunk.text == text).unwrap();
        let path = chunk("tests slash lib dot S H.");
        let start = source.find("tests/lib.sh").unwrap();
        assert_eq!(
            (path.source_start, path.source_end),
            (
                utf16(source, start),
                utf16(source, start + "tests/lib.sh".len())
            )
        );
        let command = chunk("slash review,");
        let start = source.find("(/review),").unwrap();
        assert_eq!(
            (command.source_start, command.source_end),
            (
                utf16(source, start),
                utf16(source, start + "(/review),".len())
            )
        );
        let code = chunk("Naïve fixture underscore base text.");
        let start = source.find("Naïve").unwrap();
        assert_eq!(
            (code.source_start, code.source_end),
            (utf16(source, start), utf16(source, source.len()))
        );
    }

    #[test]
    fn long_technical_paragraph_chunks_within_limit() {
        let paths: Vec<String> = (0..10)
            .map(|n| format!("src/mod_{n}/lib.rs:{}", 100 + n))
            .collect();
        let source = format!("Paths: {}.", paths.join(" "));
        let out = technical_chunks(&source, TechnicalOptions::default());
        let vocabulary = crate::vocabulary::rules_fixture();
        let mut tokens: Vec<String> = vec!["Paths:".into()];
        for (index, path) in paths.iter().enumerate() {
            let token = if index == paths.len() - 1 {
                format!("{path}.")
            } else {
                path.clone()
            };
            let spoken = speak_technical(&token, &vocabulary, &TechnicalOptions::default());
            assert!(
                spoken.chars().count() < 70 && spoken.chars().count() > 40,
                "{spoken}"
            );
            tokens.push(spoken);
        }
        assert_eq!(joined(&out), tokens.join(" "));
        assert!(out.len() >= 5, "{} chunks", out.len());
        let source_tokens: Vec<&str> = source.split(' ').collect();
        let mut next_token = 0;
        let mut previous_end = 0;
        for chunk in &out {
            assert!(
                chunk.text.chars().count() <= STREAMING_CHUNK_CHARS,
                "{:?} exceeds the limit",
                chunk.text
            );
            let mut rest = chunk.text.as_str();
            let first = next_token;
            for spoken in &tokens[next_token..] {
                match rest.strip_prefix(spoken.as_str()) {
                    Some(after) => {
                        rest = after.trim_start();
                        next_token += 1;
                    }
                    None => break,
                }
            }
            assert!(rest.is_empty(), "{:?} splits a spoken token", chunk.text);
            assert!(chunk.source_start >= previous_end);
            previous_end = chunk.source_end;
            let covered = &source[chunk.source_start as usize..chunk.source_end as usize];
            assert_eq!(covered, source_tokens[first..next_token].join(" "));
        }
        assert_eq!(next_token, tokens.len());
    }

    #[test]
    fn oversized_technical_token_splits_between_spoken_words() {
        let token = "/home/user/projects/app/src/modules/library/crates/handy-tts-core/src/deeply/nested/module_folder/text.rs:118";
        let source = format!("See {token} now.");
        let spoken = speak_technical(
            token,
            &crate::vocabulary::rules_fixture(),
            &TechnicalOptions::default(),
        );
        assert!(spoken.chars().count() > 2 * STREAMING_CHUNK_CHARS);
        let out = technical_chunks(&source, TechnicalOptions::default());
        assert_eq!(joined(&out), format!("See {spoken} now."));
        let token_start = source.find(token).unwrap() as u32;
        let token_end = token_start + token.len() as u32;
        let parts: Vec<&TextChunk> = out
            .iter()
            .filter(|chunk| chunk.source_start >= token_start && chunk.source_start < token_end)
            .collect();
        assert!(parts.len() >= 3, "{} parts", parts.len());
        assert_eq!(parts[0].source_start, token_start);
        for pair in parts.windows(2) {
            assert_eq!(pair[0].source_end, pair[1].source_start);
            let before = source[..pair[0].source_end as usize].chars().next_back();
            assert!(
                before.is_some_and(|c| !c.is_alphanumeric()),
                "a part ends inside a source segment at {}",
                pair[0].source_end
            );
        }
        for chunk in &out {
            assert!(chunk.text.chars().count() <= STREAMING_CHUNK_CHARS);
            for word in chunk.text.trim_end_matches('.').split(' ') {
                assert!(
                    spoken.split(' ').any(|spoken_word| spoken_word == word)
                        || ["See", "now"].contains(&word),
                    "{word:?} is not a whole spoken word"
                );
            }
        }
    }

    #[test]
    fn inline_code_span_is_technical() {
        assert_eq!(
            technical_text("Call `fixture_base` and `lib.sh` now."),
            "Call fixture underscore base and lib dot S H now."
        );
        assert_eq!(
            technical_text("```\nfixture_base\n```"),
            "code block skipped."
        );
        let mut cursor = TextCursor::streaming_with(
            "```\nrun fixture_base\n```",
            true,
            Some(Arc::new(Vocabulary::builtin())),
            TechnicalOptions::default(),
        )
        .unwrap();
        assert_eq!(
            cursor.next_chunk().unwrap().unwrap().text,
            "run fixture underscore base."
        );
    }

    #[test]
    fn short_paths_read_the_last_segment() {
        let source = "Edit tests/lib.sh and src/tts/manager.rs:684 today.";
        assert_eq!(
            joined(&technical_chunks(source, short_paths())),
            "Edit lib dot S H and manager dot R S at line 684 today."
        );
        assert_eq!(
            technical_text(source),
            "Edit tests slash lib dot S H and source slash tts slash manager dot R S at line 684 today."
        );
        let token = "src/tts/manager.rs:684";
        let alone = technical_chunks(token, short_paths());
        assert_eq!(alone.len(), 1);
        assert_eq!(alone[0].text, "manager dot R S at line 684.");
        assert_eq!(
            (alone[0].source_start, alone[0].source_end),
            (0, token.len() as u32)
        );
    }

    #[test]
    fn full_links_read_host_and_path() {
        let source = "See https://github.com/cjpais/Handy?tab=readme#top today.";
        let full_links = TechnicalOptions {
            full_paths: true,
            full_links: true,
            ..TechnicalOptions::default()
        };
        assert_eq!(
            joined(&technical_chunks(source, full_links)),
            "See github dot com slash cjpais slash Handy today."
        );
        assert_eq!(technical_text(source), "See link to github.com today.");
    }

    fn skipping() -> Option<Arc<Vocabulary>> {
        let file = Vocabulary::parse(r#"{"version":1,"terms":{"ABC-123":{"skip":true}}}"#)
            .expect("test vocabulary parses");
        Some(Arc::new(Vocabulary::merged(&file)))
    }
    fn skipped_text(source: &str) -> String {
        joined(&chunks_with(
            source,
            skipping(),
            TechnicalOptions::default(),
        ))
    }

    #[test]
    fn skipped_token_keeps_surrounding_spacing() {
        assert_eq!(skipped_text("see ABC-123 now"), "see now.");
        assert_eq!(
            skipped_text("Ticket ABC-123. Next one"),
            "Ticket. Next one."
        );
        assert_eq!(skipped_text("ABC-123. Next"), "Next.");
        assert_eq!(skipped_text("Ticket **ABC-123**, then"), "Ticket, then.");
        let source = "Ticket ABC-123. Next one";
        let out = chunks_with(source, skipping(), TechnicalOptions::default());
        assert_eq!(out[0].source_start, 0);
        assert_eq!(
            out.last().expect("one chunk").source_end,
            utf16(source, source.len())
        );
    }

    fn skipping_decoration() -> Option<Arc<Vocabulary>> {
        let file = Vocabulary::parse(r#"{"version":1,"terms":{"@@":{"skip":true}}}"#)
            .expect("test vocabulary parses");
        Some(Arc::new(Vocabulary::merged(&file)))
    }

    #[test]
    fn skipped_decorative_token_keeps_surrounding_spacing() {
        let text = |source: &str| {
            joined(&chunks_with(
                source,
                skipping_decoration(),
                TechnicalOptions::default(),
            ))
        };
        assert_eq!(text("Ticket @@. Next one"), "Ticket. Next one.");
        assert_eq!(text("see @@ now"), "see now.");
        assert_eq!(text("@@, then"), "then.");
        for source in ["@@.", "@@", "@@, @@!"] {
            let mut cursor = TextCursor::streaming_with(
                source,
                false,
                skipping_decoration(),
                TechnicalOptions::default(),
            )
            .unwrap();
            assert_eq!(cursor.next_chunk().unwrap(), None, "{source}");
        }
    }

    #[test]
    fn skipped_punctuation_stays_within_the_chunk_budget() {
        let repeated = format!("# Start\n\nTicket {} next.", "ABC-123, ".repeat(400));
        let long_ending = format!("# Start\n\nTicket ABC-123{} next.", ",".repeat(300));
        for source in [repeated, long_ending] {
            let out = chunks_with(&source, skipping(), TechnicalOptions::default());
            for chunk in &out {
                assert!(
                    chunk.text.chars().count() <= STREAMING_CHUNK_CHARS,
                    "{} chars: {:?}",
                    chunk.text.chars().count(),
                    chunk.text
                );
                assert!(
                    chunk.text.chars().any(char::is_alphanumeric),
                    "punctuation-only chunk {:?}",
                    chunk.text
                );
            }
            assert!(
                out.last().expect("chunks").text.ends_with("next."),
                "{:?}",
                out.last()
            );
        }
    }

    #[test]
    fn a_document_of_only_skipped_tokens_has_no_chunks() {
        for source in ["ABC-123", "ABC-123.", "ABC-123, ABC-123!"] {
            let mut cursor =
                TextCursor::streaming_with(source, false, skipping(), TechnicalOptions::default())
                    .unwrap();
            assert_eq!(cursor.next_chunk().unwrap(), None, "{source}");
        }
    }

    #[test]
    fn skip_needs_technical_reading() {
        assert_eq!(
            joined(&chunks_with(
                "see ABC-123 now",
                None,
                TechnicalOptions::default()
            )),
            "see ABC-123 now."
        );
        assert_eq!(
            joined(&chunks_with(
                "Ticket ABC-123. Next one",
                None,
                TechnicalOptions::default()
            )),
            joined(&today("Ticket ABC-123. Next one"))
        );
    }

    fn spans(chunks: &[TextChunk]) -> Vec<(&str, u32, u32)> {
        chunks
            .iter()
            .map(|chunk| (chunk.text.as_str(), chunk.source_start, chunk.source_end))
            .collect()
    }
    fn spoken_with_pauses(chunks: &[TextChunk]) -> Vec<(String, u32)> {
        chunks
            .iter()
            .map(|chunk| (chunk.text.clone(), chunk.pause_ms))
            .collect()
    }

    #[test]
    fn skipped_endings_leave_one_strongest_mark() {
        let mismatches: Vec<(&str, String, &str)> = [
            ("Ticket ABC-123, ABC-123. Next one", "Ticket. Next one."),
            ("Ticket, ABC-123. Next one", "Ticket. Next one."),
            ("Ticket ABC-123, more", "Ticket, more."),
            ("Ticket? ABC-123. Next one", "Ticket? Next one."),
            ("Ticket ABC-123; ABC-123, more", "Ticket; more."),
            ("Ticket ABC-123: ABC-123; more", "Ticket; more."),
            ("Ticket ABC-123?! Next one", "Ticket? Next one."),
            ("Ticket ABC-123,,, more", "Ticket, more."),
            ("Ticket... ABC-123? Next one", "Ticket? Next one."),
            ("\"lib.sh?\", ABC-123. Next one", "lib dot S H? Next one."),
        ]
        .into_iter()
        .filter_map(|(source, expected)| {
            let actual = skipped_text(source);
            (actual != expected).then_some((source, actual, expected))
        })
        .collect();
        assert!(
            mismatches.is_empty(),
            "(source, actual, expected): {mismatches:#?}"
        );
    }

    #[test]
    fn skipped_sentence_mark_chunks_as_if_written() {
        let mut pairs = vec![
            (
                "Ticket ABC-123, ABC-123. Next one".to_owned(),
                "Ticket. Next one".to_owned(),
            ),
            (
                "Ticket, ABC-123. Next one".to_owned(),
                "Ticket. Next one".to_owned(),
            ),
            ("Ticket ABC-123, more".to_owned(), "Ticket, more".to_owned()),
            (
                "This opening sentence is long enough to stop ABC-123. The rest follows after it"
                    .to_owned(),
                "This opening sentence is long enough to stop. The rest follows after it"
                    .to_owned(),
            ),
        ];
        for pad in 1..=14 {
            let lead = format!("# Start\n\n{} {}", "x".repeat(pad), "word ".repeat(18));
            let written = format!("{lead}end. After that a closing sentence.");
            for skipped in ["end ABC-123.", "end, ABC-123.", "end ABC-123, ABC-123."] {
                pairs.push((
                    format!("{lead}{skipped} After that a closing sentence."),
                    written.clone(),
                ));
            }
        }
        let mismatches: Vec<_> = pairs
            .iter()
            .filter_map(|(skipped, written)| {
                let actual = spoken_with_pauses(&chunks_with(
                    skipped,
                    skipping(),
                    TechnicalOptions::default(),
                ));
                let expected = spoken_with_pauses(&chunks_with(
                    written,
                    skipping(),
                    TechnicalOptions::default(),
                ));
                (actual != expected).then_some((skipped.as_str(), actual, expected))
            })
            .collect();
        assert!(
            mismatches.is_empty(),
            "(source, actual, expected): {mismatches:#?}"
        );
    }

    #[test]
    fn skipped_ending_stays_out_of_the_heading_before_it() {
        let out = chunks_with(
            "# Start\n\nABC-123? Next.",
            skipping(),
            TechnicalOptions::default(),
        );
        assert_eq!(spans(&out), vec![("Start.", 2, 7), ("Next.", 18, 23)]);
        assert_eq!(out[0].pause_ms, 600);
    }

    #[test]
    fn skipped_ending_stays_out_of_the_paragraph_before_it() {
        let out = chunks_with(
            "First para\n\nABC-123. Second para",
            skipping(),
            TechnicalOptions::default(),
        );
        assert_eq!(
            spans(&out),
            vec![("First para.", 0, 10), ("Second para.", 21, 32)]
        );
        assert_eq!(out[0].pause_ms, 450);
    }

    #[test]
    fn a_block_of_only_skipped_tokens_leaves_the_block_before_it_alone() {
        let out = chunks_with(
            "First para\n\nABC-123. ABC-123!\n\nThird",
            skipping(),
            TechnicalOptions::default(),
        );
        assert_eq!(
            spans(&out),
            vec![("First para.", 0, 10), ("Third.", 31, 36)]
        );
        assert_eq!(out[0].pause_ms, 450);
    }

    #[test]
    fn skipped_ending_stays_out_of_the_list_item_before_it() {
        let out = chunks_with(
            "- Ticket\n- ABC-123. next",
            skipping(),
            TechnicalOptions::default(),
        );
        assert_eq!(spans(&out), vec![("Ticket.", 2, 8), ("next.", 20, 24)]);
        assert_eq!(out[0].pause_ms, 300);
    }

    #[test]
    fn skipped_ending_stays_out_of_a_code_block_edge() {
        let code_chunks = |source: &str| {
            let mut cursor =
                TextCursor::streaming_with(source, true, skipping(), TechnicalOptions::default())
                    .unwrap();
            std::iter::from_fn(|| cursor.next_chunk().unwrap()).collect::<Vec<_>>()
        };
        let into = code_chunks("Ticket\n\n```\nABC-123. x\n```\n");
        assert_eq!(spans(&into)[0], ("Ticket.", 0, 6));
        assert_eq!(into[0].pause_ms, 450);
        let source = "```\nx ABC-123\n```\n\nABC-123? Next.";
        let out_of = code_chunks(source);
        assert_eq!(spans(&out_of)[0], ("x.", 4, 5));
        assert_eq!(out_of[0].pause_ms, 250);
        assert_eq!(
            spans(&out_of)[1],
            (
                "Next.",
                utf16(source, source.len() - 5),
                utf16(source, source.len())
            )
        );
    }

    #[test]
    fn punctuation_left_by_prose_keeps_its_space() {
        for source in ["wait ... what", "so . then", "a ?! b"] {
            assert_eq!(
                joined(&technical_chunks(source, TechnicalOptions::default())),
                joined(&today(source)),
                "{source}"
            );
        }
    }
}
#[cfg(test)]
mod alignment {
    use super::*;

    fn builtin() -> Option<Arc<Vocabulary>> {
        Some(Arc::new(Vocabulary::builtin()))
    }
    fn skipping() -> Option<Arc<Vocabulary>> {
        let file = Vocabulary::parse(r#"{"version":1,"terms":{"ABC-123":{"skip":true}}}"#)
            .expect("test vocabulary parses");
        Some(Arc::new(Vocabulary::merged(&file)))
    }
    fn utf16_slice(text: &str, start: u32, end: u32) -> String {
        let units: Vec<u16> = text.encode_utf16().collect();
        String::from_utf16(&units[start as usize..end as usize]).expect("span on a char boundary")
    }
    /// Each span as (source slice, spoken slice), in order.
    fn slices(source: &str, chunks: &[AlignedChunk]) -> Vec<(String, String)> {
        chunks
            .iter()
            .flat_map(|aligned| {
                aligned.words.iter().map(|word| {
                    (
                        utf16_slice(source, word.source_start, word.source_end),
                        utf16_slice(&aligned.chunk.text, word.spoken_start, word.spoken_end),
                    )
                })
            })
            .collect()
    }

    #[test]
    fn aligned_chunks_equal_streaming_chunks() {
        let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/text");
        let cases: std::collections::BTreeMap<String, Vec<String>> =
            serde_json::from_str(include_str!("../tests/fixtures/text/goldens.json")).unwrap();
        let mut sources: Vec<String> = cases
            .keys()
            .map(|name| std::fs::read_to_string(fixtures.join(name)).unwrap())
            .collect();
        sources.push(
            "Cached files go here: tests/lib.sh has a cache_dir helper that returns notes/.cache/demo/.tests."
                .to_string(),
        );
        assert_eq!(sources.len(), 8);
        for source in &sources {
            for vocabulary in [None, builtin()] {
                let options = TechnicalOptions::default();
                let mut cursor =
                    TextCursor::streaming_with(source, false, vocabulary.clone(), options).unwrap();
                let streamed: Vec<TextChunk> =
                    std::iter::from_fn(|| cursor.next_chunk().unwrap()).collect();
                let aligned: Vec<TextChunk> = prepare_reading(source, false, vocabulary, options)
                    .unwrap()
                    .into_iter()
                    .map(|aligned| aligned.chunk)
                    .collect();
                assert_eq!(aligned, streamed);
            }
        }
    }

    #[test]
    fn spans_use_utf16_offsets_and_cover_wrapped_tokens() {
        let source = "😀 Edit **README.md**, then x.";
        let chunks =
            prepare_reading(source, false, builtin(), TechnicalOptions::default()).unwrap();
        let spans = slices(source, &chunks);
        assert_eq!(spans.len(), 4, "{spans:?}");
        assert_eq!(spans[0], ("Edit".to_string(), "Edit".to_string()));
        assert!(spans[1].0.contains("README.md"), "{spans:?}");
        assert!(!spans[1].0.contains("Edit") && !spans[1].0.contains("then"));
        assert_eq!(spans[1].1, "README dot markdown,");
        assert_eq!(spans[2].0, "then");
        assert_eq!(spans[3].0, "x.");
        assert_eq!(chunks[0].words[0].source_start, 3);

        let source = "東京 README.md";
        let chunks =
            prepare_reading(source, false, builtin(), TechnicalOptions::default()).unwrap();
        assert_eq!(
            slices(source, &chunks),
            [
                ("東京".to_string(), "東京".to_string()),
                ("README.md".to_string(), "README dot markdown".to_string()),
            ]
        );
    }

    #[test]
    fn split_word_has_a_span_per_part() {
        let source = format!("{} end", "x".repeat(150));
        let chunks = prepare_reading(&source, false, None, TechnicalOptions::default()).unwrap();
        let words: Vec<WordSpan> = chunks.iter().flat_map(|c| c.words.clone()).collect();
        assert!(chunks.len() >= 2 && words.len() >= 3, "{words:?}");
        let parts = &words[..words.len() - 1];
        assert_eq!(parts[0].source_start, 0);
        assert!(
            parts
                .windows(2)
                .all(|w| w[0].source_end == w[1].source_start)
        );
        assert_eq!(parts.last().unwrap().source_end, 150);
        for (source_slice, spoken_slice) in &slices(&source, &chunks) {
            assert_eq!(source_slice, spoken_slice);
        }
    }

    #[test]
    fn trailing_skipped_block_has_an_empty_span() {
        for source in ["see\n\nABC-123", "- see\n- ABC-123"] {
            let chunks =
                prepare_reading(source, false, skipping(), TechnicalOptions::default()).unwrap();
            let texts: Vec<&str> = chunks.iter().map(|c| c.chunk.text.as_str()).collect();
            assert_eq!(texts, ["see."], "{source:?}");
            assert_eq!(
                slices(source, &chunks),
                [
                    ("see".to_string(), "see".to_string()),
                    ("ABC-123".to_string(), String::new()),
                ],
                "{source:?}"
            );
            let see_end = source.find("see").unwrap() + 3;
            assert_eq!(chunks[0].chunk.source_end as usize, see_end, "{source:?}");
        }
    }

    #[test]
    fn skipped_word_has_an_empty_span() {
        let source = "see ABC-123 now";
        let chunks =
            prepare_reading(source, false, skipping(), TechnicalOptions::default()).unwrap();
        let words: Vec<WordSpan> = chunks.iter().flat_map(|c| c.words.clone()).collect();
        assert_eq!(words.len(), 3, "{words:?}");
        assert_eq!(words[1].spoken_start, words[1].spoken_end);
        assert_eq!(
            slices(source, &chunks),
            [
                ("see".to_string(), "see".to_string()),
                ("ABC-123".to_string(), String::new()),
                ("now".to_string(), "now".to_string()),
            ]
        );

        let source = "ABC-123 now";
        let chunks =
            prepare_reading(source, false, skipping(), TechnicalOptions::default()).unwrap();
        assert_eq!(
            slices(source, &chunks),
            [
                ("ABC-123".to_string(), String::new()),
                ("now".to_string(), "now".to_string()),
            ]
        );
    }
}
#[cfg(test)]
mod table_reading {
    use super::*;
    use crate::formatted::tables::{BlockKind, TableStyle, find_blocks};
    use std::path::{Path, PathBuf};

    /// A chunk as pinned in `prose-goldens.json`: each word span as
    /// `[source_start, source_end, spoken_start, spoken_end]`.
    #[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
    struct Recorded {
        index: usize,
        text: String,
        source_start: u32,
        source_end: u32,
        pause_ms: u32,
        words: Vec<[u32; 4]>,
    }
    /// One fixture read one way: `vocabulary` is the builtin vocabulary (technical reading on).
    #[derive(Debug, serde::Serialize, serde::Deserialize)]
    struct ProseCase {
        fixture: String,
        vocabulary: bool,
        read_code: bool,
        chunks: Vec<Recorded>,
    }

    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
    }
    /// The fixtures pinned in `prose-goldens.json`, as paths under `tests/fixtures`.
    fn prose_fixtures() -> Vec<String> {
        let cases: std::collections::BTreeMap<String, Vec<String>> =
            serde_json::from_str(include_str!("../tests/fixtures/text/goldens.json")).unwrap();
        let mut names: Vec<String> = cases.keys().map(|name| format!("text/{name}")).collect();
        names.extend(
            [
                "speech/calibration-prose.txt",
                "speech/owner-2x.txt",
                "text/tables/lanes.txt",
                "text/tables/multiline.txt",
            ]
            .map(String::from),
        );
        names
    }
    fn recorded(chunks: Vec<AlignedChunk>) -> Vec<Recorded> {
        chunks
            .into_iter()
            .map(|aligned| Recorded {
                index: aligned.chunk.index,
                text: aligned.chunk.text,
                source_start: aligned.chunk.source_start,
                source_end: aligned.chunk.source_end,
                pause_ms: aligned.chunk.pause_ms,
                words: aligned
                    .words
                    .iter()
                    .map(|w| [w.source_start, w.source_end, w.spoken_start, w.spoken_end])
                    .collect(),
            })
            .collect()
    }
    /// Every fixture read with and without the builtin vocabulary, code blocks skipped and read.
    fn prose_cases() -> Vec<ProseCase> {
        let mut cases = Vec::new();
        for fixture in prose_fixtures() {
            let source = std::fs::read_to_string(fixtures().join(&fixture)).unwrap();
            for vocabulary in [false, true] {
                for read_code in [false, true] {
                    let chosen = vocabulary.then(|| Arc::new(Vocabulary::builtin()));
                    let chunks =
                        prepare_reading(&source, read_code, chosen, TechnicalOptions::default())
                            .unwrap();
                    cases.push(ProseCase {
                        fixture: fixture.clone(),
                        vocabulary,
                        read_code,
                        chunks: recorded(chunks),
                    });
                }
            }
        }
        cases
    }

    /// Regenerates `prose-goldens.json` (one case per line). Run it only when prose reading
    /// changes on purpose; `non_table_text_is_unchanged` leaves table chunks out of the check.
    #[test]
    #[ignore = "regenerates tests/fixtures/text/prose-goldens.json"]
    fn record_prose_goldens() {
        let lines: Vec<String> = prose_cases()
            .iter()
            .map(|case| serde_json::to_string(case).unwrap())
            .collect();
        std::fs::write(
            fixtures().join("text/prose-goldens.json"),
            format!("[\n{}\n]\n", lines.join(",\n")),
        )
        .unwrap();
    }

    const MULTILINE: &str = include_str!("../tests/fixtures/text/tables/multiline.txt");
    const LANES: &str = include_str!("../tests/fixtures/text/tables/lanes.txt");
    const MULTILINE_A: &str = "Table, 3 columns, 2 rows. Row 1. Lane: B, the walk. Progress: Task B1 committed, working on B2. Owner: Opus. Row 2. Lane: E. Progress: 9 files changed. Owner: gpt-6.1-sol. End of table. Table, 3 columns, 2 rows. Row 1. Lane: B, the walk. Model: Opus. Progress: Task B1 committed (b574c34). Row 2. Lane: E. Model: gpt-6.1-sol. Progress: 9 files changed, unstaged. End of table.";
    /// The spec's expected reading of the multi-line box table, verbatim.
    const SPEC_A: &str = "Table, 3 columns, 2 rows. Row 1. Lane: B, the walk. Progress: Task B1 committed, working on B2. Owner: Opus. Row 2. Lane: E. Progress: 9 files changed. Owner: gpt-6.1-sol. End of table.";

    fn builtin() -> Option<Arc<Vocabulary>> {
        Some(Arc::new(Vocabulary::builtin()))
    }
    fn style(tables: TableStyle) -> TechnicalOptions {
        TechnicalOptions {
            tables,
            ..TechnicalOptions::default()
        }
    }
    fn read(
        source: &str,
        vocabulary: Option<Arc<Vocabulary>>,
        tables: TableStyle,
    ) -> Vec<AlignedChunk> {
        prepare_reading(source, false, vocabulary, style(tables)).unwrap()
    }
    fn joined(chunks: &[AlignedChunk]) -> String {
        chunks
            .iter()
            .map(|aligned| aligned.chunk.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }
    fn utf16(source: &str, byte: usize) -> u32 {
        source[..byte].encode_utf16().count() as u32
    }
    fn utf16_slice(text: &str, start: u32, end: u32) -> String {
        let units: Vec<u16> = text.encode_utf16().collect();
        String::from_utf16(&units[start as usize..end as usize]).expect("span on a char boundary")
    }
    /// The byte range of the line of `source` that starts with `prefix`, line break excluded.
    fn line(source: &str, prefix: &str) -> Range<usize> {
        let start = if source.starts_with(prefix) {
            0
        } else {
            source.find(&format!("\n{prefix}")).expect("line present") + 1
        };
        let end = source[start..]
            .find('\n')
            .map_or(source.len(), |at| start + at);
        start..end
    }
    /// The UTF-16 ranges of the `Table` blocks of `source`.
    fn table_ranges(source: &str) -> Vec<(u32, u32)> {
        find_blocks(source)
            .into_iter()
            .filter(|block| matches!(block.kind, BlockKind::Table(_)))
            .map(|block| {
                (
                    utf16(source, block.range.start),
                    utf16(source, block.range.end),
                )
            })
            .collect()
    }
    /// The multi-line fixture's box table: (block, header line end, row 1, row 2), in bytes.
    fn multiline_box() -> (Range<usize>, usize, Range<usize>, Range<usize>) {
        let bottom = line(MULTILINE, "└");
        let header = line(MULTILINE, "│ Lane");
        let row_1 = line(MULTILINE, "│ B, the").start..line(MULTILINE, "│ walk").end;
        let row_2 = line(MULTILINE, "│ E ");
        (0..bottom.end, header.end, row_1, row_2)
    }

    /// Resumes at every UTF-16 offset of a table block and checks the reading starts again at
    /// the intro before the header ends, at the row holding the offset (or the next row on a
    /// rule line), and at "End of table." after the last row, with nothing lost or repeated.
    fn assert_resume_restarts_rows(
        source: &str,
        vocabulary: Option<Arc<Vocabulary>>,
        tables: TableStyle,
        block: Range<usize>,
        header_end: usize,
        rows: &[Range<usize>],
    ) {
        let options = style(tables);
        let full: Vec<String> = prepare_reading(source, false, vocabulary.clone(), options)
            .unwrap()
            .into_iter()
            .map(|aligned| aligned.chunk.text)
            .collect();
        let intro = full
            .iter()
            .position(|text| text.starts_with("Table, "))
            .expect("intro chunk");
        let after_intro = |prefix: &str| {
            intro
                + full[intro..]
                    .iter()
                    .position(|text| text.starts_with(prefix))
                    .unwrap_or_else(|| panic!("no chunk starts with {prefix:?} in {full:?}"))
        };
        let mark = if tables == TableStyle::NamesOnce {
            ':'
        } else {
            '.'
        };
        for (byte, _) in source[block.clone()].char_indices() {
            let byte = block.start + byte;
            let p = utf16(source, byte);
            let expected = if byte < header_end {
                intro
            } else if let Some(row) = rows.iter().position(|row| byte < row.end) {
                after_intro(&format!("Row {}{mark}", row + 1))
            } else {
                after_intro("End of table.")
            };
            let mut cursor =
                TextCursor::streaming_with(source, false, vocabulary.clone(), options).unwrap();
            cursor.resume_at(p, 0);
            let resumed: Vec<String> = std::iter::from_fn(|| cursor.next_chunk().unwrap())
                .map(|chunk| chunk.text)
                .collect();
            assert_eq!(
                resumed.join(" "),
                full[expected..].join(" "),
                "resume at UTF-16 offset {p} (byte {byte})"
            );
        }
    }

    #[test]
    fn non_table_text_is_unchanged() {
        let recorded: Vec<ProseCase> =
            serde_json::from_str(include_str!("../tests/fixtures/text/prose-goldens.json"))
                .unwrap();
        let current = prose_cases();
        assert_eq!(recorded.len(), 44);
        assert_eq!(recorded.len(), current.len());
        for (old, new) in recorded.iter().zip(&current) {
            let case = format!(
                "{} vocabulary={} read_code={}",
                new.fixture, new.vocabulary, new.read_code
            );
            assert_eq!(
                (&old.fixture, old.vocabulary, old.read_code),
                (&new.fixture, new.vocabulary, new.read_code)
            );
            let source = std::fs::read_to_string(fixtures().join(&new.fixture)).unwrap();
            let tables = table_ranges(&source);
            let prose = |chunks: &[Recorded]| {
                chunks
                    .iter()
                    .filter(|chunk| {
                        !tables.iter().any(|&(start, end)| {
                            chunk.source_start < end && start < chunk.source_end
                        })
                    })
                    .map(|chunk| {
                        (
                            chunk.text.clone(),
                            chunk.source_start,
                            chunk.source_end,
                            chunk.pause_ms,
                            chunk.words.clone(),
                        )
                    })
                    .collect::<Vec<_>>()
            };
            let (old_prose, new_prose) = (prose(&old.chunks), prose(&new.chunks));
            if tables.is_empty() {
                assert_eq!(old_prose.len(), old.chunks.len(), "{case}");
            }
            assert_eq!(new_prose, old_prose, "{case}");
        }
    }

    #[test]
    fn multiline_box_table_reads_style_a() {
        assert!(MULTILINE_A.starts_with(SPEC_A));
        for vocabulary in [None, builtin()] {
            let chunks = read(MULTILINE, vocabulary, TableStyle::NameEach);
            assert_eq!(joined(&chunks), MULTILINE_A);
            assert_eq!(
                chunks[..8]
                    .iter()
                    .map(|aligned| aligned.chunk.text.as_str())
                    .collect::<Vec<_>>(),
                [
                    "Table, 3 columns, 2 rows.",
                    "Row 1. Lane: B, the walk.",
                    "Progress: Task B1 committed, working on B2.",
                    "Owner: Opus.",
                    "Row 2. Lane: E.",
                    "Progress: 9 files changed.",
                    "Owner: gpt-6.1-sol.",
                    "End of table.",
                ]
            );
            assert_eq!(
                chunks[..8]
                    .iter()
                    .map(|aligned| aligned.chunk.pause_ms)
                    .collect::<Vec<_>>(),
                [280, 280, 280, 280, 280, 280, 280, 450]
            );
        }
    }

    #[test]
    fn multiline_reads_style_b() {
        for vocabulary in [None, builtin()] {
            assert_eq!(
                joined(&read(MULTILINE, vocabulary, TableStyle::NamesOnce)),
                "Table, 3 columns, 2 rows. Columns: Lane, Progress, Owner. Row 1: B, the walk; Task B1 committed, working on B2. Opus. Row 2: E; 9 files changed; gpt-6.1-sol. End of table. Table, 3 columns, 2 rows. Columns: Lane, Model, Progress. Row 1: B, the walk; Opus; Task B1 committed (b574c34). Row 2: E; gpt-6.1-sol; 9 files changed, unstaged. End of table."
            );
        }
    }

    #[test]
    fn lanes_table_reads_every_cell_once_in_order() {
        let chunks = read(LANES, None, TableStyle::NameEach);
        assert_eq!(
            joined(&chunks),
            "Lanes. Table, 3 columns, 3 rows. Row 1. Lane: B, the walk (critical path). Model: Opus. Progress: Task B1 committed (b574c34): the per-pass host ledger at the network layer. Working on B2. Row 2. Lane: A, access and admission. Model: Opus. Progress: Starting point verified, 10 files changed, first commit not yet made. Row 3. Lane: E, settle and checker. Model: gpt-6.1-sol. Progress: 9 files changed and left unstaged (its sandbox can't commit). It notes its migration needs the second reviewer, as planned. End of table."
        );
        for aligned in &chunks {
            assert!(
                !aligned
                    .chunk
                    .text
                    .chars()
                    .any(|c| ('\u{2500}'..='\u{257F}').contains(&c)),
                "{:?}",
                aligned.chunk.text
            );
        }
    }

    #[test]
    fn table_chunks_cover_whole_rows() {
        let (block, header_end, row_1, row_2) = multiline_box();
        let chunks = read(MULTILINE, None, TableStyle::NameEach);
        let range = |aligned: &AlignedChunk| (aligned.chunk.source_start, aligned.chunk.source_end);
        let utf =
            |bytes: &Range<usize>| (utf16(MULTILINE, bytes.start), utf16(MULTILINE, bytes.end));
        let texts: Vec<&str> = chunks.iter().map(|a| a.chunk.text.as_str()).collect();
        let first = texts.iter().position(|t| t.starts_with("Row 1.")).unwrap();
        let last = texts.iter().position(|t| *t == "Owner: Opus.").unwrap();
        assert_eq!(last - first, 2);
        for aligned in &chunks[first..=last] {
            assert_eq!(range(aligned), utf(&row_1), "{:?}", aligned.chunk.text);
        }
        for aligned in &chunks[last + 1..last + 4] {
            assert_eq!(range(aligned), utf(&row_2), "{:?}", aligned.chunk.text);
        }
        assert_eq!(range(&chunks[0]), utf(&(block.start..header_end)));
        assert_eq!(chunks[last + 4].chunk.text, "End of table.");
        assert_eq!(range(&chunks[last + 4]), utf(&(row_2.end..block.end)));
        for pair in chunks.windows(2) {
            assert!(pair[0].chunk.source_start <= pair[1].chunk.source_start);
        }
        let blocks = table_ranges(MULTILINE);
        assert_eq!(blocks.len(), 2);
        let mut in_table = None;
        for aligned in &chunks {
            if aligned.chunk.text.starts_with("Table, ") {
                in_table = Some(blocks[usize::from(in_table.is_some())]);
            }
            let Some((start, end)) = in_table else {
                continue;
            };
            let (chunk_start, chunk_end) = range(aligned);
            assert!(
                start <= chunk_start && chunk_end <= end,
                "{:?} outside its table",
                aligned.chunk.text
            );
        }
    }

    /// The whole reading of a small table, literal: labels carry the row range and no span,
    /// every cell word its own UTF-16 span. `alignment.test.ts` holds the same literal.
    #[test]
    fn small_table_aligned_chunks_are_exact() {
        let chunk = |index: usize, text: &str, start: u32, end: u32, pause_ms: u32| TextChunk {
            index,
            text: text.into(),
            source_start: start,
            source_end: end,
            pause_ms,
        };
        let span = |source_start, source_end, spoken_start, spoken_end| WordSpan {
            source_start,
            source_end,
            spoken_start,
            spoken_end,
        };
        assert_eq!(
            prepare_reading(
                "| A | B |\n|---|---|\n| x y | z |",
                false,
                None,
                TechnicalOptions::default()
            )
            .unwrap(),
            vec![
                AlignedChunk {
                    chunk: chunk(0, "Table, 2 columns, 1 row.", 0, 9, 280),
                    words: vec![],
                },
                AlignedChunk {
                    chunk: chunk(1, "Row 1. A: x y.", 20, 31, 280),
                    words: vec![span(22, 23, 10, 11), span(24, 25, 12, 13)],
                },
                AlignedChunk {
                    chunk: chunk(2, "B: z.", 20, 31, 280),
                    words: vec![span(28, 29, 3, 4)],
                },
                AlignedChunk {
                    chunk: chunk(3, "End of table.", 20, 31, 450),
                    words: vec![],
                },
            ]
        );
    }

    #[test]
    fn labels_have_no_spans_and_cell_words_have_exact_ones() {
        let chunks = read(MULTILINE, None, TableStyle::NameEach);
        let box_chunks = &chunks[..8];
        let spans: Vec<&WordSpan> = box_chunks.iter().flat_map(|a| &a.words).collect();
        assert_eq!(spans.len(), 15);
        let written: Vec<String> = spans
            .iter()
            .map(|span| utf16_slice(MULTILINE, span.source_start, span.source_end))
            .collect();
        assert_eq!(
            written.join(" "),
            "B, the walk Task B1 committed, working on B2. Opus E 9 files changed gpt-6.1-sol"
        );
        for word in &written {
            for label in ["Lane", "Progress", "Owner", "Row", "Table"] {
                assert!(!word.contains(label), "{word:?} covers {label:?}");
            }
        }
        for aligned in box_chunks {
            for pair in aligned.words.windows(2) {
                assert!(pair[0].source_start < pair[1].source_start);
            }
            for span in &aligned.words {
                assert_eq!(
                    utf16_slice(&aligned.chunk.text, span.spoken_start, span.spoken_end),
                    utf16_slice(MULTILINE, span.source_start, span.source_end)
                );
            }
        }
    }

    #[test]
    fn resume_inside_a_row_restarts_that_row() {
        let (block, header_end, row_1, row_2) = multiline_box();
        for tables in [TableStyle::NameEach, TableStyle::NamesOnce] {
            assert_resume_restarts_rows(
                MULTILINE,
                None,
                tables,
                block.clone(),
                header_end,
                &[row_1.clone(), row_2.clone()],
            );
        }
    }

    #[test]
    fn long_cell_word_keeps_the_row_range() {
        let path = "/home/user/projects/app/src/modules/library/crates/handy-tts-core/src/deeply/nested/module_folder/text.rs:118";
        let cjk = "表".repeat(150);
        let source = format!("| File | Note |\n|---|---|\n| {path} | x |\n| {cjk} | y |\n");
        let header = line(&source, "| File");
        let rows = [line(&source, "| /home"), line(&source, "| 表")];
        let block = 0..rows[1].end;
        for vocabulary in [None, builtin()] {
            let chunks = read(&source, vocabulary.clone(), TableStyle::NameEach);
            let mut row = None;
            let mut per_row = [0, 0];
            for aligned in &chunks {
                let text = aligned.chunk.text.as_str();
                if let Some(n) = ["Row 1.", "Row 2."]
                    .iter()
                    .position(|r| text.starts_with(r))
                {
                    row = Some(n);
                } else if text == "End of table." {
                    row = None;
                }
                let Some(n) = row else { continue };
                per_row[n] += 1;
                assert_eq!(
                    (aligned.chunk.source_start, aligned.chunk.source_end),
                    (utf16(&source, rows[n].start), utf16(&source, rows[n].end)),
                    "{text:?}"
                );
            }
            assert!(per_row[1] >= 3, "the CJK cell is split: {per_row:?}");
            if vocabulary.is_some() {
                assert!(per_row[0] >= 3, "the spoken path is split: {per_row:?}");
            }
            assert_resume_restarts_rows(
                &source,
                vocabulary,
                TableStyle::NameEach,
                block.clone(),
                header.end,
                &rows,
            );
        }
    }

    #[test]
    fn headerless_and_empty_cells() {
        let headerless = "┌───┬───┐\n│ a │ b │\n│ c │ d │\n└───┴───┘";
        let empty = "| Name | Note |\n|---|---|\n| A | |\n| | x |";
        for (source, tables, expected) in [
            (
                headerless,
                TableStyle::NameEach,
                "Table, 2 columns, 2 rows. Row 1. Column 1: a. Column 2: b. Row 2. Column 1: c. Column 2: d. End of table.",
            ),
            (
                headerless,
                TableStyle::NamesOnce,
                "Table, 2 columns, 2 rows. Row 1: a; b. Row 2: c; d. End of table.",
            ),
            (
                empty,
                TableStyle::NameEach,
                "Table, 2 columns, 2 rows. Row 1. Name: A. Row 2. Note: x. End of table.",
            ),
            (
                empty,
                TableStyle::NamesOnce,
                "Table, 2 columns, 2 rows. Columns: Name, Note. Row 1: A; blank. Row 2: blank; x. End of table.",
            ),
        ] {
            assert_eq!(joined(&read(source, None, tables)), expected, "{source:?}");
        }
    }

    #[test]
    fn header_names_are_read_as_plain_text() {
        let source = "┌───┬──────┐\n│ # │ Lane │\n├───┼──────┤\n│ 1 │ B    │\n└───┴──────┘";
        assert_eq!(
            joined(&read(source, None, TableStyle::NameEach)),
            "Table, 2 columns, 1 row. Row 1. #: 1. Lane: B. End of table."
        );
        assert_eq!(
            joined(&read(source, None, TableStyle::NamesOnce)),
            "Table, 2 columns, 1 row. Columns: #, Lane. Row 1: 1; B. End of table."
        );
    }

    #[test]
    fn table_style_serializes_snake_case_and_defaults_to_name_each() {
        assert_eq!(TableStyle::default(), TableStyle::NameEach);
        assert_eq!(TechnicalOptions::default().tables, TableStyle::NameEach);
        assert_eq!(
            serde_json::to_string(&[TableStyle::NameEach, TableStyle::NamesOnce]).unwrap(),
            r#"["name_each","names_once"]"#
        );
        assert_eq!(
            crate::formatted::tables::intro(3, 2),
            "Table, 3 columns, 2 rows."
        );
        assert_eq!(
            crate::formatted::tables::intro(1, 1),
            "Table, 1 column, 1 row."
        );
    }

    #[test]
    fn long_phrases_chunk_between_words() {
        let names = [
            "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india",
            "juliett", "kilo", "lima", "mike", "november",
        ];
        let values: Vec<String> = (1..=names.len()).map(|n| n.to_string()).collect();
        let source = format!(
            "| {} |\n|{}\n| {} |",
            names.join(" | "),
            "---|".repeat(names.len()),
            values.join(" | ")
        );
        let columns = format!("Columns: {}.", names.join(", "));
        assert!(columns.chars().count() > STREAMING_CHUNK_CHARS);
        let expected = format!(
            "Table, 14 columns, 1 row. {columns} Row 1: {}. End of table.",
            values.join("; ")
        );
        let chunks = read(&source, None, TableStyle::NamesOnce);
        assert_eq!(joined(&chunks), expected);
        let words: Vec<&str> = expected.split(' ').collect();
        for aligned in &chunks {
            let text = &aligned.chunk.text;
            assert!(text.chars().count() <= STREAMING_CHUNK_CHARS, "{text:?}");
            for word in text.split(' ') {
                assert!(words.contains(&word), "{word:?} is cut out of a word");
            }
        }
    }

    /// A cell whose only word the vocabulary skips keeps its span in its own chunk, so every
    /// chunk's spans stay in source order even when wrapped cells are read column by column.
    #[test]
    fn skipped_cell_keeps_spans_in_source_order() {
        let wrapped = "┌───────┬───────┬───────┐\n│ H1    │ H2    │ H3    │\n├───────┼───────┼───────┤\n│ a     │       │ c     │\n│ z     │ SKIP  │ d     │\n├───────┼───────┼───────┤\n│ b     │ x     │ e     │\n└───────┴───────┴───────┘";
        let first = "| H1 | H2 |\n|---|---|\n| SKIP | b |";
        let file = Vocabulary::parse(r#"{"version":1,"terms":{"SKIP":{"skip":true}}}"#).unwrap();
        let skipping = Some(Arc::new(Vocabulary::merged(&file)));
        for (source, names_once) in [
            (
                wrapped,
                "Table, 3 columns, 2 rows. Columns: H1, H2, H3. Row 1: a z; blank; c d. Row 2: b; x; e. End of table.",
            ),
            (
                first,
                "Table, 2 columns, 1 row. Columns: H1, H2. Row 1: blank; b. End of table.",
            ),
        ] {
            let skip = source.find("SKIP").unwrap();
            let skip = (utf16(source, skip), utf16(source, skip + "SKIP".len()));
            for tables in [TableStyle::NameEach, TableStyle::NamesOnce] {
                let chunks = read(source, skipping.clone(), tables);
                for aligned in &chunks {
                    assert!(
                        aligned
                            .words
                            .windows(2)
                            .all(|pair| pair[0].source_end <= pair[1].source_start),
                        "spans not in source order: {aligned:?}"
                    );
                }
                let skipped: Vec<&WordSpan> = chunks
                    .iter()
                    .flat_map(|aligned| &aligned.words)
                    .filter(|span| (span.source_start, span.source_end) == skip)
                    .collect();
                assert_eq!(skipped.len(), 1, "{tables:?} {source:?}");
                assert_eq!(skipped[0].spoken_start, skipped[0].spoken_end);
                if tables == TableStyle::NamesOnce {
                    assert_eq!(joined(&chunks), names_once);
                }
            }
        }
    }

    fn is_box_drawing(c: char) -> bool {
        ('\u{2500}'..='\u{257F}').contains(&c)
    }
    /// The multi-line fixture's box table, without the Markdown table after it.
    fn multiline_box_only() -> &'static str {
        &MULTILINE[..MULTILINE.find("\n\n").unwrap()]
    }

    #[test]
    fn table_only_fence_reads_as_table_even_with_code_off() {
        let boxed = multiline_box_only();
        let expected = "Intro. Table, 3 columns, 2 rows. Row 1. Lane: B, the walk. Progress: Task B1 committed, working on B2. Owner: Opus. Row 2. Lane: E. Progress: 9 files changed. Owner: gpt-6.1-sol. End of table. After.";
        for fence in [
            format!("```\n{boxed}\n```"),
            format!("```text\n{boxed}\n```"),
            format!("```\n\n{boxed}\n\n```"),
        ] {
            let source = format!("Intro.\n\n{fence}\n\nAfter.");
            let fence_start = source.find("```").unwrap();
            let fence_end = source.rfind("```").unwrap() + 3;
            for read_code in [false, true] {
                for vocabulary in [None, builtin()] {
                    let chunks = prepare_reading(
                        &source,
                        read_code,
                        vocabulary,
                        TechnicalOptions::default(),
                    )
                    .unwrap();
                    let case = format!("read_code={read_code} {source:?}");
                    assert_eq!(joined(&chunks), expected, "{case}");
                    let intro = chunks
                        .iter()
                        .find(|a| a.chunk.text.starts_with("Table, "))
                        .unwrap();
                    assert_eq!(
                        intro.chunk.source_start,
                        utf16(&source, fence_start),
                        "{case}"
                    );
                    let end = chunks
                        .iter()
                        .find(|a| a.chunk.text == "End of table.")
                        .unwrap();
                    assert_eq!(end.chunk.source_end, utf16(&source, fence_end), "{case}");
                }
            }
        }
    }

    #[test]
    fn mixed_fence_keeps_code_behaviour() {
        let source = "```\n$ tree\n├── src\n│   └── main.rs\n└── README.md\n```";
        for vocabulary in [None, builtin()] {
            let chunks = prepare_reading(
                source,
                false,
                vocabulary.clone(),
                TechnicalOptions::default(),
            )
            .unwrap();
            assert_eq!(joined(&chunks), "code block skipped.");
            let chunks =
                prepare_reading(source, true, vocabulary, TechnicalOptions::default()).unwrap();
            for aligned in &chunks {
                assert!(
                    !aligned.chunk.text.chars().any(is_box_drawing),
                    "{:?}",
                    aligned.chunk.text
                );
            }
        }
        let spaced: String = source
            .chars()
            .map(|c| if is_box_drawing(c) { ' ' } else { c })
            .collect();
        let read = super::tests::prepared(source, true);
        assert!(!read.chars().any(is_box_drawing), "{read:?}");
        assert_eq!(read, super::tests::prepared(&spaced, true));
    }

    #[test]
    fn stray_box_characters_are_never_spoken() {
        for vocabulary in [None, builtin()] {
            for (source, expected) in [
                ("Status ──── done\n\n├── src", "Status done. src."),
                ("a│b", "a b."),
            ] {
                let chunks = prepare_reading(
                    source,
                    false,
                    vocabulary.clone(),
                    TechnicalOptions::default(),
                )
                .unwrap();
                assert_eq!(joined(&chunks), expected, "{source:?}");
            }
        }
        // Inline code, inline HTML and an HTML block drop them too.
        for (source, expected) in [
            ("Run `ls │ wc` and <b>x─y</b>.", "Run ls wc and x y."),
            ("<div>\na─b\n</div>", "a b."),
        ] {
            assert_eq!(
                super::tests::prepared(source, false),
                expected,
                "{source:?}"
            );
        }
    }

    /// Spec Goal 4: border characters typed inside Markdown cells, header names included, are
    /// not spoken either.
    #[test]
    fn box_characters_in_markdown_cells_are_never_spoken() {
        let source = "| Lane ─ id | Note |\n|---|---|\n| a │ b | c ┼ d |";
        for vocabulary in [None, builtin()] {
            for (tables, expected) in [
                (
                    TableStyle::NameEach,
                    "Table, 2 columns, 1 row. Row 1. Lane id: a b. Note: c d. End of table.",
                ),
                (
                    TableStyle::NamesOnce,
                    "Table, 2 columns, 1 row. Columns: Lane id, Note. Row 1: a b; c d. End of table.",
                ),
            ] {
                let chunks = read(source, vocabulary.clone(), tables);
                assert_eq!(joined(&chunks), expected, "{tables:?}");
                for aligned in &chunks {
                    assert!(!aligned.chunk.text.chars().any(is_box_drawing));
                }
            }
        }
    }

    fn alphanumeric_tokens(text: &str) -> Vec<&str> {
        text.split(|c: char| !c.is_alphanumeric())
            .filter(|token| !token.is_empty())
            .collect()
    }

    /// A block that is not read as a table is read in source order with its borders dropped:
    /// every alphanumeric token of the block, in order, and no border character. Every case is
    /// checked before the test fails, so the failure lists each case that lost or spoke something.
    #[test]
    fn fallback_never_drops_words() {
        let cases = [
            (
                "box with a wall missing",
                "┌───┬───┐\n│ h │ i │\n├───┼───┤\n│ a   b │\n└───┴───┘",
            ),
            (
                "box junction off by one",
                "┌───┬───┐\n│ h │ i │\n├────┼──┤\n│ a │ b │\n└───┴───┘",
            ),
            (
                "ascii wall missing",
                "+---+---+\n| a | b |\n| c d |\n+---+---+",
            ),
            (
                "ascii mismatched junctions",
                "+---+---+\n| h | i |\n+--+----+\n| a | b |\n+---+---+",
            ),
            (
                "box spanning title",
                "┌───────┐\n│ Title │\n├───┬───┤\n│ a │ b │\n└───┴───┘",
            ),
            (
                "markdown row wider than the header",
                "| a | b |\n|---|---|\n| 1 | 2 | 3 |",
            ),
            (
                "one-column notice",
                "╭────────────────────────╮\n│ Update available       │\n│ Restart to install it. │\n╰────────────────────────╯",
            ),
        ];
        let mut failures = Vec::new();
        for (name, block) in cases {
            let blocks = find_blocks(block);
            assert!(
                matches!(blocks.as_slice(), [only] if matches!(only.kind, BlockKind::Fallback { .. }) && only.range == (0..block.len())),
                "{name} is not one fallback block: {blocks:?}"
            );
            let wrapped = format!("Before.\n\n{block}\n\nAfter.");
            for vocabulary in [None, builtin()] {
                for tables in [TableStyle::NameEach, TableStyle::NamesOnce] {
                    let text = joined(&read(block, vocabulary.clone(), tables));
                    let lost = alphanumeric_tokens(&text) != alphanumeric_tokens(block);
                    let border = text.contains('|')
                        || text.contains('+')
                        || text.contains("---")
                        || text.chars().any(is_box_drawing);
                    let around = joined(&read(&wrapped, vocabulary.clone(), tables));
                    let around_ok = around == format!("Before. {text} After.");
                    if lost || border || !around_ok {
                        failures.push(format!(
                            "{name} (vocabulary={}, {tables:?}): {text:?} around: {around:?}",
                            vocabulary.is_some()
                        ));
                    }
                }
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
        assert_eq!(
            joined(&read(cases[4].1, None, TableStyle::NameEach)),
            "Title a b."
        );
    }

    /// A fallback block's words keep their own source ranges, in source order.
    #[test]
    fn fallback_words_keep_their_own_ranges() {
        let source = "Before.\n\n+---+---+\n| a | b |\n| c d |\n+---+---+\n\nAfter.";
        let chunks = read(source, None, TableStyle::NameEach);
        let spans: Vec<String> = chunks
            .iter()
            .flat_map(|aligned| &aligned.words)
            .map(|span| utf16_slice(source, span.source_start, span.source_end))
            .collect();
        assert_eq!(spans, ["Before.", "a", "b", "c", "d", "After."]);
        let all: Vec<&WordSpan> = chunks.iter().flat_map(|aligned| &aligned.words).collect();
        for pair in all.windows(2) {
            assert!(pair[0].source_end <= pair[1].source_start, "{pair:?}");
        }
        let fallback = &chunks[1].chunk;
        assert_eq!(fallback.text, "a b c d.");
        assert_eq!(fallback.pause_ms, 450);
        let a = source.find("a |").unwrap();
        let d = source.find("d |").unwrap() + 1;
        assert_eq!(
            (fallback.source_start, fallback.source_end),
            (utf16(source, a), utf16(source, d))
        );
    }

    /// Reference links and footnotes keep their definitions across a table, on either side of
    /// it, and a reference inside a Markdown cell resolves against the whole text, as it did
    /// before tables were read.
    #[test]
    fn references_keep_their_definitions_across_a_table() {
        let table = "| A | B |\n|---|---|\n| x | y |";
        let defined = "[ref]: https://example.com/path\n\n[^1]: omit footnote";
        let reads = "Table, 2 columns, 1 row. Row 1. A: x. B: y. End of table.";
        for (source, expected) in [
            (
                format!("See [guide][ref] and note[^1].\n\n{table}\n\n{defined}"),
                format!("See guide and note. {reads}"),
            ),
            (
                format!("{defined}\n\n{table}\n\nSee [guide][ref] and note[^1]."),
                format!("{reads} See guide and note."),
            ),
            (
                "[ref]: https://example.com/path\n\n| A | B |\n|---|---|\n| [guide][ref] | y[^1] |\n\n[^1]: omit footnote"
                    .to_string(),
                "Table, 2 columns, 1 row. Row 1. A: guide. B: y. End of table.".to_string(),
            ),
        ] {
            for vocabulary in [None, builtin()] {
                for tables in [TableStyle::NameEach, TableStyle::NamesOnce] {
                    let text = joined(&read(&source, vocabulary.clone(), tables));
                    if tables == TableStyle::NameEach {
                        assert_eq!(text, expected, "{source:?}");
                    } else {
                        assert!(!text.contains('['), "{source:?}: {text:?}");
                    }
                }
            }
        }
    }

    /// A reference with no definition anywhere still reads literally, in prose and in a cell.
    #[test]
    fn unresolved_references_still_read_literally() {
        let prose = "See [guide][nowhere] and note[^9].";
        let source = format!("{prose}\n\n| A | B |\n|---|---|\n| [x][nowhere] | y |");
        let text = joined(&read(&source, None, TableStyle::NameEach));
        let alone = joined(&read(prose, None, TableStyle::NameEach));
        assert!(alone.contains("[guide][nowhere]"), "{alone:?}");
        assert_eq!(
            text,
            format!("{alone} Table, 2 columns, 1 row. Row 1. A: [x][nowhere]. B: y. End of table.")
        );
    }

    /// Prose on the line right before or after a table ends and starts as its own paragraph.
    #[test]
    fn prose_glued_to_a_table_reads_as_its_own_paragraph() {
        let source =
            "Intro line\n┌───┬───┐\n│ a │ b │\n├───┼───┤\n│ c │ d │\n└───┴───┘\nAfter line";
        let chunks = read(source, None, TableStyle::NameEach);
        assert_eq!(
            joined(&chunks),
            "Intro line. Table, 2 columns, 1 row. Row 1. a: c. b: d. End of table. After line."
        );
        assert_eq!(chunks[0].chunk.pause_ms, 450);
        assert_eq!(
            (chunks[0].chunk.source_start, chunks[0].chunk.source_end),
            (0, 10)
        );
    }

    /// Many tables and many definitions: the whole source is parsed once (every Markdown event
    /// is read once, no definition is copied per table) and every reference resolves.
    #[test]
    fn document_is_parsed_once_with_many_tables_and_definitions() {
        let source: String = (0..400)
            .map(|k| {
                format!("[r{k}]: https://e.com/{k}\n\nSee [g{k}][r{k}].\n\n| A |\n|---|\n| [x{k}][r{k}] |\n\n")
            })
            .collect();
        let reads = std::rc::Rc::new(std::cell::Cell::new(0_usize));
        let counted = document_events(&source).inspect({
            let reads = reads.clone();
            move |_| reads.set(reads.get() + 1)
        });
        let items = source_items(&source, counted).count();
        assert_eq!(reads.get(), document_events(&source).count());
        assert!(
            items <= reads.get(),
            "{items} items for {} events",
            reads.get()
        );
        let text = joined(&read(&source, None, TableStyle::NameEach));
        assert!(!text.contains('['), "{text:?}");
        assert_eq!(text.matches("End of table.").count(), 400);
        assert!(text.contains("See g399. Table, 1 column, 1 row. Row 1. A: x399. End of table."));
    }
}
