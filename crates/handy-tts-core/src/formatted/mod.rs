//! Formatted-text steps that run before the text cursor: each finds one kind of structure in
//! the read text by source byte range, so the cursor can speak it in its own way. Tables are
//! the first.

pub mod tables;
