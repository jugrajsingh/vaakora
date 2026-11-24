# Vaakora

**Local dictation, transcript cleanup and read aloud for Linux. Everything runs on your own computer.**

## At a glance

- **Dictation:** press a shortcut, speak, and your words appear in any text field.
- **Local cleanup:** a small language model can tidy the transcript.
- **Read aloud:** another shortcut reads the text you copied back to you.
- **Command line and agents:** a `vaakora` command controls the running app, and optional skills let Claude Code and Codex read aloud when you ask.
- **Private by default:** audio and text stay on the machine.
- **Linux desktop app:** built and tested on Fedora 44 (KDE Plasma, Wayland).

## What it does

### Dictation

Press a configurable shortcut, speak, and the transcript is pasted into the app you are using.

- **Shortcut:** hold it to record and release to stop, or tap it to toggle recording on and off.
- **Silence:** filtered with Silero voice activity detection.
- **Models:** transcription runs locally with Whisper models (with GPU acceleration when available) or Parakeet V3.
- **Custom words:** offline Parakeet models with a TDT or RNN-T decoder take your custom words as they recognise speech. Live (streaming) models never get them and keep correcting them afterwards.
- **Shortcut changes:** applied atomically, and a usable dictation shortcut is always kept.
- **Paste helpers:** the programs that paste dictated text run under a deadline, so a hung helper cannot hold up dictation.

### Local post-processing

A "Local (in-app)" post-processing provider cleans up a transcript with a small language model that runs on the CPU.

- Runs through a bundled `llama-server`. Nothing has to be installed or started separately.
- Transcripts never leave the machine.
- Five downloadable models are offered, each pinned to a fixed revision, size and SHA-256.
- History keeps which model produced each cleaned-up entry and compares it with the raw text.
- A **Raw Shortcut** sits next to the **Post-processing Shortcut**.

### Read aloud

A shortcut reads the text you last copied, in a popup that follows along.

- **Shortcut:** Super+Alt+R by default.
- **Follow-along popup:** highlights the sentence being read.
- **Streaming and controls:** reading is streamed and has speed and pitch controls.
- **Markdown:** marks are not spoken, and code blocks are skipped unless you ask for them; a code block that holds only a table is read as a table.
- **Tables:** box-drawing, ASCII and Markdown tables are read row by row, each value with its column name, and their borders are not spoken. Box-drawing characters are never spoken anywhere, and a table that cannot be read with confidence is read in its original order without its borders.
- **Technical reading:** paths, file names, flags, versions and code names are spoken the way an engineer would say them.
- **Vocabulary:** extend the spoken forms in `tts-vocabulary.json` in the app data directory. It also accepts entries for one voice model only.
- **No overlap:** dictation and reading never overlap.

Eight downloadable voice models are offered. GPU and NPU mean an Intel GPU or NPU through OpenVINO.

| Voice model                                     | Runs on                              |
| ----------------------------------------------- | ------------------------------------ |
| Pocket TTS                                      | CPU, GPU and NPU in part (see below) |
| Supertonic 3                                    | CPU, GPU, NPU                        |
| Kokoro-82M                                      | CPU, GPU, NPU                        |
| Paradee-8M                                      | CPU                                  |
| Phonon 31M (English)                            | CPU                                  |
| Indic Tiny TTS (Indian English, Hindi, Punjabi) | CPU, GPU                             |

- The app picks the best device that works on the machine.
- Pocket TTS keeps part of its work on the CPU (ONNX Runtime). On the GPU only its text conditioner runs there, and its main flow model, flow sampler and audio decoder stay on the CPU. On the NPU its main flow model stays on the CPU.

The full list of changes is in [CHANGELOG.md](CHANGELOG.md). Its new interface strings are translated into the other 26 languages by machine and have not been reviewed by native speakers.

## Command line and agents

The `vaakora` command also drives the running app from a terminal, a script or a coding agent. It needs the app to be running: it never starts it, and exits with 3 when there is nothing to talk to.

- `vaakora read [file|-]` reads a file aloud, or text piped in on standard input (`-` or no file). The text is never taken from an argument, because other programs on the machine could see it.
- `vaakora pause`, `vaakora resume` and `vaakora stop` control the reader.
- `vaakora status` and `vaakora voices` report what the app is doing and which voices are downloaded. Add `--json` for JSON.
- `vaakora dictate [--post-process|--cancel]` toggles a dictation, with or without post-processing, or cancels it.
- `vaakora transcribe <file> [--json]` prints the transcript of an audio file. The file is added to History, as Transcribe a file does there.

Reads that come from the command line or an agent are saved in Read aloud history with a small "from agent" tag. A read you start with the shortcut is not tagged.

Exit codes, for scripts:

| Code | Meaning                                                                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Done. `pause`, `resume` and `stop` also exit 0 when there was nothing to change, and say so on stderr.                                                                           |
| 1    | The app answered with an error, such as a `transcribe` file it cannot find or decode, or the output could not be written.                                                        |
| 2    | Usage error, found before the app is asked: an unknown option, no file and no piped text, a path that is not a file, or text that is blank, not UTF-8, over 1 MiB or unreadable. |
| 3    | The app cannot be reached: it is not running, there is no runtime directory or the socket path is too long, or it did not answer in time.                                        |
| 4    | A dictation is in progress. The dictation goes on and nothing is read.                                                                                                           |
| 5    | A model is missing: the speech model, or the voice model the reader needs, is not downloaded or ready.                                                                           |

Right after the app starts, `vaakora read` can return exit 5 (`tts-unavailable`) for a moment, while read aloud is still loading. Run it again.

### Agent skills

`vaakora agent install [--claude] [--codex] [--dry-run]` writes two skills, `vaakora-read` and `vaakora-stop`, for Claude Code (`~/.claude/skills`) and Codex (`~/.agents/skills`). Without a flag it installs for both, and `--dry-run` lists what it would write and writes nothing.

- **Explicit only:** the skills never run on their own. In Claude Code you invoke `/vaakora-read <path>` or `/vaakora-stop`, and in Codex `$vaakora-read`. Installing is a command you run; nothing installs a skill for you.
- **Your files are safe:** the command refuses to touch a skill folder it did not write, and `vaakora agent uninstall` removes only the files it wrote.
- **A temporary file:** to read text from the conversation, the skill writes it to a file in `$XDG_RUNTIME_DIR`, never in a repository, and deletes it after `vaakora read` finishes. Claude Code may ask once before it allows that deletion.

### Privacy

- The app listens on `$XDG_RUNTIME_DIR/vaakora.sock` (or `$VAAKORA_SOCKET`). The socket is readable and writable only by you, in a folder only you can open, and the app answers only processes that run as your user.
- Text reaches the app through a file or standard input, never as an argument, and the socket's own logging never holds it.
- The socket is local to the machine. Nothing is sent over a network.

## Platform support

- Built and tested on Fedora 44 (KDE Plasma, Wayland) on an Intel Core Ultra 7 258V.
- Local post-processing needs Unix sockets and uses the Linux parent-death signal to stop `llama-server` if the app dies. The `llama-server` bundling is Linux-only.
- Read aloud's worker process, its OpenVINO libraries, the parent-death signal and the 1 GiB free-memory check are Linux-only. On other platforms the memory check is skipped. Clipboard capture uses `wl-paste` or `xclip` on Linux.
- The device ratings shown in Models, Read aloud were measured on that one machine. Other hardware may rank devices differently.
- Windows and macOS are not supported by these features yet.
- There is one maintainer and no published packages yet.

## Building

### Build from source

1. Install the prerequisites in [BUILD.md](BUILD.md).
2. Stage the extra build requirements from the "Relationship to upstream" section of [CHANGELOG.md](CHANGELOG.md): a static, CPU-only `llama-server` as `llm-bin/`, and the text-to-speech worker with its OpenVINO libraries as `tts-bin/`.
3. Install the dependencies:

   ```bash
   bun install
   ```

4. Start the dev server, or build for production:

   ```bash
   bun tauri dev
   bun run tauri build
   ```

### Build the Linux RPM

This builds from this repository in one step. The details are in [packaging/README.md](packaging/README.md).

1. Commit your changes. The build refuses a dirty tree.
2. Run the build script:

   ```bash
   packaging/build.sh
   ```

3. Find the RPM in `packaging/dist/`.

## Built on Handy

Vaakora began as a fork of [Handy](https://github.com/cjpais/Handy) by CJ Pais, used under the MIT licence. Handy's name, logo and brand assets are not part of Vaakora. Vaakora is not affiliated with or endorsed by Handy or its author.

- The transcription engines and models are upstream's.
- Vaakora pins the speech-to-text engine, transcribe.cpp, to a revision past upstream's v0.4.2 that adds phrase boosting.
- Vaakora's other additions are the local post-processing, read aloud, the command line and the dictation changes above.
- [UPSTREAM.md](UPSTREAM.md) records the upstream base and what was decided for each upstream commit since.
- The "Relationship to upstream" section of [CHANGELOG.md](CHANGELOG.md) lists every setting, event, command, dependency and upstream file that Vaakora touches.
- The models the app can download have their own licences, which the app shows on each model's card.

## Licence

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Jugraj Singh and Copyright (c) 2025 CJ Pais.

## Acknowledgments

- **Handy** by CJ Pais, the project Vaakora began as
- **Whisper** by OpenAI for the speech recognition model
- **ggml** for an amazing cross-platform tensor library
- **Silero** for great lightweight VAD
- **Tauri** team for the excellent Rust-based app framework
