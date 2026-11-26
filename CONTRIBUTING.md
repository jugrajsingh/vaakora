# Contributing to Vaakora

Thank you for helping. There is one maintainer, so replies may take time.

## Feedback

Report bugs and send feature ideas through [GitHub Issues](https://github.com/jugrajsingh/vaakora/issues). The issue forms ask for what helps most: your version, how you installed it, your distribution and desktop, and the logs.

To report a security problem, follow [SECURITY.md](SECURITY.md) and do not open an issue.

## Where help is welcome

- Linux packaging and distribution, for example a Copr project, an AUR package or other distributions.
- Windows and macOS ports. Both are coming soon and neither is released yet.
- Translations: read [CONTRIBUTING_TRANSLATIONS.md](CONTRIBUTING_TRANSLATIONS.md).

For anything large, open an issue first so we can agree on the approach before you write code.

## Build and test

- [BUILD.md](BUILD.md) lists the prerequisites and how to build from source.
- [packaging/README.md](packaging/README.md) covers the Linux packages, the dev loop (`packaging/dev.sh` runs cargo and bun in the build image) and the tests.

Before you open a pull request, run the checks that apply to your change:

- `cargo fmt --all`, `cargo clippy` and `cargo test` for Rust changes.
- `bun run lint` for frontend changes.
- `bun run format:check` for formatting.
- `bun run check:docs` for changes to `docs/`, and `bun run check:brand` for changes to branding.

## Pull requests

- Keep each pull request to one focused change.
- Use a conventional commit prefix (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`) and explain why in the message, not what.
- Note user-visible changes under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- Do not include private paths, host names or secrets.

## Relationship to upstream

Vaakora began as a fork of [Handy](https://github.com/cjpais/Handy). A fix that applies to Handy itself is better sent to [cjpais/Handy](https://github.com/cjpais/Handy). [UPSTREAM.md](UPSTREAM.md) records what was taken from upstream and what was decided for each commit.
