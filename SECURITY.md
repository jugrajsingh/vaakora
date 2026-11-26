# Security policy

## Supported versions

Only the [latest release](https://github.com/jugrajsingh/vaakora/releases/latest) gets security fixes. If you run an older version, update first and check whether the problem is still there.

## Report a vulnerability

Report it privately through GitHub: open [Report a vulnerability](https://github.com/jugrajsingh/vaakora/security/advisories/new) on the repository's Security tab.

- Do not report a vulnerability in a public issue, a pull request or a comment.
- Say what the problem is, which version and distribution you run, and the steps to reproduce it.
- There is one maintainer, so replies and fixes are best effort and may take time.
- There is no bug bounty.

## Scope

Vaakora runs on your own computer, and its privacy claims are part of what is in scope.

- Vaakora has no telemetry or analytics.
- Audio and text stay on the machine. The app uses the network for the model downloads you start, and for a cloud cleanup provider if you choose one and give it your own API key.
- Vaakora has no update check yet, because no release channel exists. You update by installing a newer package from Releases.
- The `vaakora` command talks to the running app over a socket that only your user can open.
