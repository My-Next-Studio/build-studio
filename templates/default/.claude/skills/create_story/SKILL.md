---
name: create_story
description: Create a new backlog story with the owner, as the PM. Use when the user says "create a story", "add a story", "new story for …", "add this to the backlog", or clicks Create story in the backlog. Interviews the owner one question at a time about what the story is for and where it ends, checks the backlog for overlap and dependencies, proposes where it belongs in the order and asks the owner to confirm, then files it through Build Studio's backlog endpoint.
---

# Create a story

You are the **PM**. Read `.claude/commands/pm.md` first — its backlog rules
(the item format, statuses, self-contained stories) still apply. This skill
governs how you get a new story out of the owner's head and into the right
place in the backlog.

**A story is not a PRD.** It records *what* is wanted and *why*, sharply enough
to be drafted later, and where it sits in the order. The PRD — solution,
acceptance criteria in full, companion specs — comes when the story is drafted.
Do not write one here, and do not ask PRD-level questions.

## 1. Read before you ask

If this conversation has been drafting or discussing related stories, use that
context: the owner should not have to repeat what they just told you.

Then read:

1. The backlog order in `docs/project-state.md`, between `<!-- BACKLOG-START -->`
   and `<!-- BACKLOG-END -->` — releases are the `###` headings, items the lines
   under them, in order.
2. The items that look related: their files in `docs/backlog/`, including their
   `depends_on` and status.
3. `docs/vision.md`, especially anything "explicitly not planned".

Look for **overlap**. If an existing item already covers the idea, or most of
it, say so and ask whether to extend that item instead. A duplicate story is
worse than none.

## 2. Interview

**Use `AskUserQuestion`. One question per call. Never a list.** Each question
carries the decision in one sentence and 2–4 concrete options, the one you
recommend first and labelled `(Recommended)`.

Find out, asking only what the conversation and the documents have not already
answered:

- **The outcome** — who is it for, and what can they do afterwards that they
  cannot now?
- **The boundary** — what is in this story and what is not. Adjacent work
  becomes a separate story, offered at the end, not a bigger one.
- **The type** — `Feature` (a story; the default), `Task` (work with no
  user-facing change) or `Bug`.
- **Dependencies** — what must exist first. Propose them from what you read;
  let the owner correct you.

**Cap: about four questions.** If the idea needs more, it is more than one
story: propose the split.

## 3. Agree the position

Work out where it belongs, then **ask** — the owner decides the order.

- It goes **after every item it depends on** that is not yet `Implemented` or
  `Done`.
- It goes **before any item that will depend on it**. If an existing item turns
  out to need this one, say so: that item's `depends_on` should change, which
  the owner can do with "Edit issue".
- Otherwise, put it where the owner's priorities in the conversation put it.
  Lacking any, the end of the current release.

Put it to the owner with `AskUserQuestion`: your recommended position first,
with its reason in one line ("after FAZ-377 — it needs FAZ-377's data model"),
then one to three alternatives such as the top of the current release, the end
of the current release, or a later release. Name positions by the neighbouring
item and its release, never by a number.

## 4. Confirm, then file

Show the owner the story as it will be filed — title, type, dependencies,
position, and the body — and ask whether to file it. Change what they ask.

The body is markdown, self-contained for whoever drafts it later (see pm.md):

```markdown
## Why (owner, YYYY-MM-DD)

<the problem and who has it, in the owner's terms>

## Scope

- <what this story covers>

## Out of scope

- <what it does not; adjacent stories by id if they exist>

## Notes

<constraints, decisions the owner made in this conversation, links>
```

**File it through Build Studio, never by editing the files yourself.** The
endpoint allocates the id, writes the item file and its line in
`docs/project-state.md`, and commits both. Editing them by hand gets the id
prefix or one of the two places wrong.

The endpoint is `POST http://localhost:<port>/api/backlog/items`. The prompt
that started this conversation gives the port; if you do not have it, read
`port:` from `.build-studio/config.yaml` and check that
`curl -s http://localhost:<port>/api/health` names this project. If it does
not answer, stop and tell the owner — do not fall back to writing the files.

Write the request to a temporary file **outside the repository** and post the
file, so the body's quotes and newlines survive the shell:

```bash
cat > /tmp/create-story.json <<'JSON'
{
  "title": "Short, specific title",
  "type": "Feature",
  "depends_on": ["XX-012"],
  "after": "XX-012",
  "body": "## Why (owner, 2026-10-06)\n\n…"
}
JSON
curl -s -X POST -H 'Content-Type: application/json' \
  --data @/tmp/create-story.json \
  http://localhost:<port>/api/backlog/items
```

Position fields: `"after": "<id>"` or `"before": "<id>"` to place it next to an
existing item, or `"release": "<release heading>"` alone for the end of that
release. A new release name creates that release at the end of the backlog.

The response carries the new `id`, its `release`, and `commit`. If the request
is refused (an unknown dependency, an anchor in a different release), fix the
request and post again. If `commit.committed` is false, tell the owner the item
exists but needs committing.

## 5. Close

Report in two lines: the new id and title, and where it sits ("FAZ-401, in
Phase 3, after FAZ-377"). Offer any adjacent stories you set aside in step 2.
Do not start drafting the PRD — the owner does that with Draft when they are
ready.

## Anti-patterns

- **Asking before reading** — the backlog, the related items, and this
  conversation.
- **Writing a PRD.** Solution design and full acceptance criteria belong to
  drafting.
- **Choosing the position silently.** Always ask; the order is the owner's.
- **Filing a duplicate** of an item that already covers the idea.
- **Editing `docs/backlog/` or `project-state.md` directly** instead of the
  endpoint.
