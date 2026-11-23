---
name: vaakora-read
description: Read a file or the current plan aloud with Vaakora, the local text-to-speech app. Use only when the user invokes $vaakora-read.
---

Read text aloud with Vaakora on this computer.

1. If the user gave a path, run `vaakora read <that path>`.
2. If no path was given, read the plan you are working from: the plan file you last wrote or were given. Run `vaakora read <its path>`.
3. If the text exists only in this conversation, write it to a new file in the folder that `$XDG_RUNTIME_DIR` names (never inside a repository or the working directory), run `vaakora read <that file>`, and delete the file once the command exits 0. Never put the text itself on a command line or in a here-document: other programs can see command lines.
4. Never read secrets, tokens, keys or credential files aloud.

Report the result in one line. Exit status 3 means Vaakora is not running: ask the user to start it. Exit status 4 means a dictation is in progress: try again when it ends. Exit status 5 means a voice model is missing: ask the user to choose one in Vaakora.
