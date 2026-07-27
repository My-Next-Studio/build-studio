# Security Policy

## Reporting a vulnerability

**Please report privately — do not open a public issue.**

Use GitHub's private vulnerability reporting, which is enabled on this
repository: go to the [Security tab][security] → **Report a vulnerability**.
That opens a private thread visible only to the maintainers.

[security]: https://github.com/My-Next-Studio/build-studio/security/advisories/new

Helpful things to include, as far as you have them:

- What an attacker can achieve, and what access they need to start
- Steps to reproduce, ideally the smallest case that shows it
- Affected version or commit, and your OS
- Whether it is already public anywhere

You'll get an acknowledgement as soon as the report is seen. Build Studio is
maintained by one person alongside other work, so please treat response times as
best-effort rather than a guarantee — you will get an honest answer about whether
and when a fix is coming.

If you'd like credit in the advisory and changelog, say so and how you'd like to
be named. Please give us a chance to ship a fix before disclosing publicly.

## Scope

Build Studio is a **local development tool** for a single developer on their own
machine. It is not hardened for shared, multi-user, or production environments,
and that is a design choice rather than an oversight.

Two consequences follow, and reports in these areas are expected to account for
them:

- **The hub and project servers are unauthenticated by design.** They bind to
  `127.0.0.1`, so the trust boundary is the machine. `BUILD_STUDIO_LISTEN_HOST`
  can widen that binding; doing so knowingly exposes an unauthenticated API and
  is the operator's decision.
- **Agents execute code on purpose.** Workflows run AI agents that write and run
  code, install dependencies, and commit to your repositories. That is the
  product, not a vulnerability.

**In scope** — anything that breaks those boundaries rather than relying on them.
For example: reaching the API from outside the machine under default settings,
escaping a project's directory, injecting commands into a shell invocation,
leaking credentials or API keys into logs, prompts, or committed files, or a
dependency shipping exploitable code into the app.

**Out of scope** — behaviour that follows from the documented design: the
unauthenticated local API on its default loopback binding, an agent modifying
files in a project you pointed it at, or consequences of deliberately setting
`BUILD_STUDIO_LISTEN_HOST` to a non-loopback address.

If you are unsure which side of that line a finding falls on, report it. A report
that turns out to be in-scope-by-design is a cheap mistake; an unreported real
issue is not.

## Supported versions

Build Studio ships from `main` and has no tagged releases. Fixes land on `main`;
there is no backporting. If you run a fork, pull from upstream to pick up
security fixes, and watch [CHANGELOG.md](CHANGELOG.md), where anything with
security impact is recorded along with the steps needed to actually deploy it.
