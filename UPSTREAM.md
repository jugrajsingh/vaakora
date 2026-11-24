# Upstream

Upstream: https://github.com/cjpais/Handy (git remote `upstream`, push disabled)
Base: aca8985190c3ad7f361d8a80cb30f179513ed690 (v0.10.1), imported as 35d085e

Decisions: `adopted` (taken as is), `rewritten` (taken in changed form), `declined`, `already-here` (the change is already in the tree), `pending` (not yet decided).

Credit: a commit that carries a change taken from outside has a body line `Based on: <owner>/<repo>@<sha> by <name>`, and the commit itself is authored and signed by the maintainer. `scripts/check-provenance.ts` checks this both ways. Every such line in the history needs an adopted or rewritten row naming the commit as "Our commit" with the same source, in the upstream commit table or the fork table. Every adopted or rewritten row of the upstream commit table needs a commit that carries a matching line. The pull request and fork tables are not required to have lines, because their commits were not recommitted under a credit line.

| Upstream commit | Subject                                                                | Decision  | Our commit |
| --------------- | ---------------------------------------------------------------------- | --------- | ---------- |
| 4807c21a        | feat: add Thai translation (#2529)                                     | rewritten | c073caf3   |
| 939c9573        | fix: let the output device pick the feedback sound buffer size (#2525) | adopted   | e650de94   |

## Open upstream pull requests taken before they merge

Taken as rewritten changes, with the behaviour of the pull request and our own code and tests. There is no upstream commit to record yet.

| Pull request | Subject                                                                                      | Author         | Decision  | Our commit |
| ------------ | -------------------------------------------------------------------------------------------- | -------------- | --------- | ---------- |
| #2148        | fix(linux): bound feedback sound playback so a wedged output device cannot lock the mic/sink | Taha Kotil     | rewritten | f0b3e134   |
| #2110        | fix(audio): don't abort startup when the always-on microphone can't open                     | Niels Kootstra | rewritten | f0b3e134   |
| #2374        | fix: frame the structured post-processing dictation in <transcript> tags                     | Rahul          | rewritten | fc27b763   |
| #2440        | fix: keep the transcript in post-processing when a prompt has no ${output} placeholder       | Ahmed Saeed    | rewritten | fc27b763   |
| #2452        | Keep Wayland paste text out of clipboard history                                             | alanshurafa    | rewritten | 8acebd98   |
| #1906        | add ipc server                                                                               | CJ Pais        | rewritten | a4cddf6b   |

## Fork commits taken in part

Changes found in a fork of upstream. 00cbe2ba0 is taken as a rewritten change, with our own code and tests, for its echo rule only. a9e714682 is declined: its rule (a length limit on every input) is not taken (see CHANGELOG.md, Fixed). e45486388 is taken as a rewritten change: the same rule (non-ASCII text for ydotool goes through the clipboard), with one shared, lazily resolved choice of typing tool and our own tests.

| Fork commit             | Subject                                                                  | Author             | Decision  | Our commit |
| ----------------------- | ------------------------------------------------------------------------ | ------------------ | --------- | ---------- |
| maxisme/Handy@00cbe2ba0 | fix: discard post-processing output that echoes the prompt's own example | Maximilian Mitchel | rewritten | 49f94d5b   |
| maxisme/Handy@a9e714682 | fix: discard post-processing output that echoes the prompt               | Maximilian Mitchel | declined  | 49f94d5b   |
| vlazic/Handy@e45486388  | fix: paste via clipboard when ydotool would type non-ASCII text          | Vladimir Lazić     | rewritten | 056f6803   |
