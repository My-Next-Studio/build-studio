# Contributing to Build Studio

Thanks for your interest in contributing! This document covers how to propose
changes and the one legal requirement we ask of every contributor.

## Developer Certificate of Origin (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO) instead of a CLA. The DCO is a lightweight statement that you wrote the
patch, or otherwise have the right to submit it under the project's license.

You certify the DCO by adding a `Signed-off-by` line to every commit:

```
Signed-off-by: Your Name <your.email@example.com>
```

Git can add this automatically with the `-s` flag:

```bash
git commit -s -m "fix: correct the thing"
```

The name and email must match your real identity (no anonymous or fictitious
contributions). Pull requests whose commits are not signed off will be asked to
amend before merge.

### Full DCO text

The certification you make by signing off is the standard DCO 1.1, available in
full at <https://developercertificate.org/>.

## How to contribute

1. **Open an issue first** for anything beyond a small fix, so we can agree on
   the approach before you invest time.
2. **Fork and branch** from `main`.
3. **Keep changes focused.** One logical change per pull request. Don't mix
   unrelated refactors into a feature or fix.
4. **Match the existing style.** Inline styles + CSS variables in the hub,
   the `createXRouter(config)` pattern in project-server. See `CLAUDE.md` for
   conventions and architecture.
5. **Add or update tests** for behavior changes. Run the project-server test
   suite before opening a PR.
6. **Sign off your commits** (see DCO above).

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): short description` — e.g. `fix(workflow): correct auto-advance timer`.
Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`.

## Reporting bugs

Open an issue with steps to reproduce, what you expected, and what happened.
Include your OS, Node version, and relevant logs (with any secrets redacted).
