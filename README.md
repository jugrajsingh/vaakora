# Vaakora

**Local dictation, transcript cleanup and read aloud for Linux. Everything runs on your own computer.**

Vaakora is a desktop application. Press a shortcut, speak, and your words appear in any text field. A small language model can clean the transcript up, and another shortcut reads the text you copied back to you. Audio and text stay on the machine.

## What it does

**Dictation.** Press a configurable shortcut, speak, and the transcript is pasted into the app you are using. Hold the shortcut to record and release to stop, or tap it to toggle recording on and off. Silence is filtered with Silero voice activity detection, and transcription runs locally with Whisper models (with GPU acceleration when available) or Parakeet V3. Shortcut changes are applied atomically and always keep a usable dictation shortcut, and the helper programs that paste dictated text run under a deadline so a hung helper cannot hold up dictation.

**Local post-processing.** A "Local (in-app)" post-processing provider cleans up a transcript with a small language model that runs on the CPU through a bundled `llama-server`. Nothing has to be installed or started separately, and transcripts never leave the machine. Five downloadable models are offered, each pinned to a fixed revision, size and SHA-256. History keeps which model produced each cleaned-up entry and compares it with the raw text. A Raw Shortcut sits next to the Post-processing Shortcut.

**Read aloud.** A shortcut (Super+Alt+R by default) reads the text you last copied, in a popup that highlights the sentence being read. Eight downloadable voice models are offered: Pocket TTS, Supertonic 3, Kokoro-82M, Paradee-8M, Phonon 31m English and Indic Tiny TTS for Indian English, Hindi and Punjabi. Each runs on the CPU, or on an Intel GPU or NPU through OpenVINO (Paradee-8M and Phonon on the CPU only, Indic Tiny on the CPU and GPU), and the app picks the best device that works on the machine. Reading is streamed and has speed and pitch controls. Markdown marks are not spoken and code blocks are skipped unless you ask for them. Technical reading speaks paths, file names, flags, versions and code names the way an engineer would say them, using a vocabulary file you can extend (`tts-vocabulary.json` in the app data directory, which also accepts entries for one voice model only). Dictation and reading never overlap.

The full list of changes is in [CHANGELOG.md](CHANGELOG.md). Its new interface strings are translated into the other 25 languages by machine and have not been reviewed by native speakers.

## Platform support

- Built and tested on Fedora 44 (KDE Plasma, Wayland) on an Intel Core Ultra 7 258V.
- Local post-processing needs Unix sockets and uses the Linux parent-death signal to stop `llama-server` if the app dies. The `llama-server` bundling is Linux-only.
- Read aloud's worker process, its OpenVINO libraries, the parent-death signal and the 1 GiB free-memory check are Linux-only. On other platforms the memory check is skipped. Clipboard capture uses `wl-paste` or `xclip` on Linux.
- The device ratings shown in Models, Read aloud were measured on that one machine. Other hardware may rank devices differently.
- Windows and macOS are not supported by these features yet.
- There is one maintainer and no published packages yet.

## Building

Follow [BUILD.md](BUILD.md), plus the extra build requirements in the "Relationship to upstream" section of [CHANGELOG.md](CHANGELOG.md): a static, CPU-only `llama-server` staged as `llm-bin/`, and the text-to-speech worker with its OpenVINO libraries staged as `tts-bin/`.

To build the Linux RPM from this repository in one step, use [packaging/README.md](packaging/README.md).

## Built on Handy

Vaakora began as a fork of [Handy](https://github.com/cjpais/Handy) by CJ Pais, used under the MIT licence. Handy's name, logo and brand assets are not part of Vaakora. Vaakora is not affiliated with or endorsed by Handy or its author.

The transcription engines and models are upstream's, and Vaakora does not change how speech is recognised. Its additions are the local post-processing, read aloud and the dictation changes above. [UPSTREAM.md](UPSTREAM.md) records the upstream base and what was decided for each upstream commit since, and the "Relationship to upstream" section of [CHANGELOG.md](CHANGELOG.md) lists every setting, event, command, dependency and upstream file that Vaakora touches.

The models the app can download have their own licences, which the app shows on each model's card.

## Licence

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Jugraj Singh and Copyright (c) 2025 CJ Pais.

## Acknowledgments

- **Handy** by CJ Pais, the project Vaakora began as
- **Whisper** by OpenAI for the speech recognition model
- **ggml** for an amazing cross-platform tensor library
- **Silero** for great lightweight VAD
- **Tauri** team for the excellent Rust-based app framework
