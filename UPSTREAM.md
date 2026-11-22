# Upstream

Upstream: https://github.com/cjpais/Handy (git remote `upstream`, push disabled)
Base: aca8985190c3ad7f361d8a80cb30f179513ed690 (v0.10.1), imported as 35d085e

Decisions: `adopted` (taken as is), `rewritten` (taken in changed form), `declined`, `already-here` (the change is already in the tree), `pending` (not yet decided).

| Upstream commit | Subject                                                                | Decision  | Our commit |
| --------------- | ---------------------------------------------------------------------- | --------- | ---------- |
| 4807c21a        | feat: add Thai translation (#2529)                                     | rewritten | 884f1b8d   |
| 939c9573        | fix: let the output device pick the feedback sound buffer size (#2525) | adopted   | 30685a1e   |

## Open upstream pull requests taken before they merge

Taken as rewritten changes, with the behaviour of the pull request and our own code and tests. There is no upstream commit to record yet.

| Pull request | Subject                                                                                      | Author         | Decision  | Our commit |
| ------------ | -------------------------------------------------------------------------------------------- | -------------- | --------- | ---------- |
| #2148        | fix(linux): bound feedback sound playback so a wedged output device cannot lock the mic/sink | Taha Kotil     | rewritten | 8abb23b8   |
| #2110        | fix(audio): don't abort startup when the always-on microphone can't open                     | Niels Kootstra | rewritten | 8abb23b8   |
