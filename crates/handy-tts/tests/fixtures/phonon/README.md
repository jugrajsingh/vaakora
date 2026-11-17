# Phonon tokenizer fixtures

- `tokenizer.json`: copy of `tokenizer.json` from the Hugging Face repo `onnx-community/phonon-31m-en-ONNX` at revision `f0f522a750bf515227cb478abb97b2ffca7e6d8c` (169734 bytes, SHA-256 `bb2fb782d5a88704e224b6cb23663b44e60a29dc7c15fde71a2991a3efd0bdf0`). Phonon 31m English is by Gradium and licensed Apache-2.0.
- `golden.json`: rows `{input, normalized, ids}` produced from that file by Hugging Face `tokenizers` 0.23.3 (`normalizer.normalize_str(input)` and `encode(input, add_special_tokens=False).ids`). The unit test `unigram::tests::golden_corpus_matches_hf_tokenizers` requires the Rust port to reproduce every row.
