# Learnings

This directory holds **learnings** — short, reusable notes that agents capture
during workflow runs (typically in the `capture_learnings` step) and that later
runs inject as context to avoid repeating mistakes.

Each learning is a single Markdown file, grouped into a category subdirectory:

```
docs/learnings/
  architecture/
  backend/
  devops/
  frontend/
  qa/
  security/
  workflow/
```

Category folders are created on demand the first time a learning is written, so
this directory may be empty in a fresh checkout. A learning file is just a
descriptive kebab-case filename plus the lesson, for example:

```
docs/learnings/backend/validate-enum-inputs-against-the-configured-allowlist.md
```

Keep each file focused on one durable, transferable lesson — the *why* and *how
to apply it*, not a play-by-play of the run that produced it.

Capture is failure-gated (agents record a learning when something actually went
wrong or surprised them, not after every run), injected learnings are capped per
run, and each learning tracks whether it was genuinely applied — unused
learnings expire automatically. A learning that keeps proving useful can be
promoted into the project's `ARCHITECTURE.md` or role command files.
