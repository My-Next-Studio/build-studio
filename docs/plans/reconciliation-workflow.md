# Plan: bring work done outside Build Studio home (reconcile)

> **Status: proposed 2026-11-01.**
>
> Owner request: Build Studio is good at building one feature at a time and
> keeping each true to the vision. The whole machinery exists to stop a project
> drifting. That makes it slow for work like a new user experience, which is
> much faster to iterate on freely in a chat or agent app. The owner wants to
> combine the two: iterate freely in a branch or worktree, then let Build
> Studio bring the result home. It reviews and integrates the work, and makes
> code, requirements, design, architecture and tests agree again, so that
> ordinary development can continue. A reconciliation, not a git merge.

## The problem

Every workflow assumes Build Studio started the work. The execution run
creates its own `exec/<id>` branch from the default branch, and the reviewers
read a PRD that was drafted and reviewed before anything was built. Nothing
can start from a branch that already exists.

Work done outside arrives with three gaps:

- **No independent review.** If it has documents at all, they were written by
  the agent that built the code, from the code.
- **Its own numbering.** Backlog ids are allocated as "highest file + 1" in
  the checkout (`backlog.js` `nextItemId`), and PRD, UX and ADR numbers are
  chosen by agents. A branch that drafted its own items collides with the
  default branch as soon as the default branch allocates the next id.
- **No agreed intent.** The code says what was built, not what was meant.
  Leftover experiments, regressions and unrelated changes look the same as the
  intended change.

## What already exists

Most of the flow can be put together from parts that are already there.

- **Onboarding** already reconciles documents with code, for a whole codebase:
  - `discovery` inventories it;
  - `architect_backfill` writes ADRs and `ARCHITECTURE.md` from existing code;
  - `owner_interview` asks the owner;
  - `team_review` and `pm_revision` revise the result;
  - `owner_signoff` closes it.

  Reconcile is the same for a diff.
- **The interview launcher** (`kickoff-interview.js`, built on drafting's
  launcher) runs an interactive skill session with Start, Resume, End,
  Finish and Skip. It is stored on the step and kept out of the agent
  watchdogs.
- **The second half of the execution run**, from `qa_validation` on:
  `security_audit`, `owner_checks`/`demo_review`, the fix rounds
  (`launchFixPlan`), `merge_to_main` and `capture_learnings`. It works from
  `wf.branch` and `wf.prdPath`. If the agreed intent is written as PRDs, all of
  it can be reused unchanged.
- **`createItem`** files backlog items, and the `ensureCreateStorySkill`
  pattern puts a template skill into a project onboarded before that skill
  existed.

Two things in today's code the new flow must avoid:

- **`merge_to_main` deletes the branch it merges**, locally and on origin
  (`cleanupBranches`). The source branch must therefore never become
  `wf.branch`. Integration happens on a branch of its own.
- **Id allocation is per checkout**, as described above. Collisions have to
  be found and fixed when the work is integrated.

## Principles

- **Implementation does not become requirement by default.** Acceptance
  criteria are written from the owner's answers, not from the code. What the
  owner has not approved is recorded as an open question, not as a
  requirement.
- **Existing tests are not always the answer key.** An intended behaviour
  change can make a test obsolete. Changing or removing that test has to be
  justified against the approved behaviour.
- **Review is independent of the implementation.** Documents and validation
  records that come with the branch are the builder's claims. Reviewers read
  them as claims, not as fact.
- **Proportionate.** A visual refinement does not get the same scrutiny as a
  change to authentication or the data model.
- **Traceable and resumable.** Source revision, target revision, decisions,
  verification and the result are recorded.
- **One source of truth, one workflow engine.** Existing document types and
  the existing engine. No parallel documentation system.

## The flow

A new workflow type, `reconcile`, started from the Project function next to
Kickoff and Onboarding.

| # | Step | Who | Reuses | Produces |
|---|---|---|---|---|
| 1 | `intake` | engine | the onboarding inventory pattern | pinned source and target SHAs, merge-base, conflict list, risk tier, id collisions |
| 2 | `intent_interview` | owner + PM, skill `reconcile_interview` | the interview launcher | approved behaviour, as PRDs |
| 3 | `integration` | engine; a dev agent or the owner on conflict | git.js merges | branch `reconcile/<ID>` from the current default branch |
| 4 | `team_review` | roles by risk tier | onboarding's `team_review`, with a reconcile prompt | findings, proposed document changes, pushback |
| 5 | `owner_decision` | owner | a manual gate, like `owner_signoff` | a decision per finding and per document change |
| 6 | `apply` | fix agents and roles | `launchFixPlan`, `pm_revision`, `createItem` | fixes, updated documents, new backlog items |
| 7 | verify and merge | QA, security, owner | the execution run's second half, from `qa_validation` | merged; learnings captured; project state updated |

### 1. Intake

- **Input.** A branch or commit, either in the project's own repository or in
  another clone or worktree on disk (given as a path plus branch). A brief can
  be attached, such as a handover note. It is context, not truth.
- **The source must be committed.** Intake refuses while the source has
  modified or untracked files. It lists them, including untracked and
  unusually large files, so nothing is missed by accident. The owner commits
  in the source and starts again. Build Studio never writes in the source
  worktree.
- **Pinned.** The committed source is fetched into the project's repository
  and pinned on `refs/build-studio/reconcile/<id>/source`. The source SHA, the
  target SHA and the merge-base are recorded. The owner can keep working in
  the source without affecting the review.
- **Dry-run merge** with `git merge-tree --write-tree`, so conflicts are
  known before anything is merged.
- **Path classes:**
  - code
  - tests
  - documents
  - dependencies
  - migrations
  - CI and signing
  - entitlements and payments
  - analytics and consent
  - binaries (with their size)
- **Id collisions.** Backlog, PRD, UX and ADR ids that the source added and
  that the target also uses, or has allocated since the merge-base.
- **A suggested risk tier** (below), with the triggers that caused it.

### 2. Intent interview

The skill `reconcile_interview` is a sibling of `owner_interview` and
`draft_prd`, so it can also be run by hand. It follows their structure:

1. **Resolve before asking.** Read the inventory, the brief, the diff and the
   project's documents. For each change group, say what the branch *claims*
   (its own PRDs and validation records) and what can be *inferred* from the
   code. Keep the two apart.
2. **Classify** each change group as intended, a leftover experiment, an
   unintended regression, or unrelated.
3. **Choose what comes home.** In the first version, part of the work can be
   left out by excluding path groups or commits.
4. **Agree the behaviour.** Ask the owner one topic at a time, with options
   and a recommendation; "not decided yet" is always an answer. When the
   branch brought PRDs of its own, confirm or edit those rather than rewrite
   them. Otherwise write a PRD. Either way the acceptance criteria come from
   the owner's answers.
5. **Confirm the risk tier.** The owner may always raise it. To lower it, the
   owner sees what triggered it and gives a reason, which is logged.
6. **Record:** the PRDs; the record item (below); and the Key Decisions Log
   in `docs/decisions.md`.

### 3. Integration branch

`reconcile/<ID>` is cut from the current default branch, and the pinned
source is merged into it without the excluded parts. Colliding ids are
renumbered on the incoming side, because the default branch wins. A conflict
stops the step for the owner, or for a dev agent if the owner asks for one.
Every later check runs against this branch: the result as it will be, not the
source as it was.

### 4. Review, by risk tier

| Tier | Triggered by | Reviewers and verification |
|---|---|---|
| **Light** | visuals and copy only | UX, Brand, visual QA |
| **Standard** | a new or changed feature | + Architect, code review, scoped test suite |
| **Sensitive** | auth, data model or migrations, payments or entitlements, privacy, analytics or consent, CI or signing, new dependencies | + Security, the full suite, and an owner decision on every finding |

Each role is scoped to its own documents:

- **Architect:** `ARCHITECTURE.md`. A new or revised ADR only for a material
  architectural decision.
- **UX, Designer, Brand:** UX specifications, design rules, copy.
- **QA:**
  - finds missing tests;
  - checks each changed or removed test against the approved behaviour;
  - says what to run now and what is too long and belongs in the backlog.
- **Security:** only in the Sensitive tier, or when sensitive paths were
  touched.
- **CEO:** the vision, only when the interview found that the product's
  direction changed.
- **PM:** a light pass over the backlog for stories the change affects. Exact
  coverage is not needed; drafting and review catch the rest later.

Every reviewer gives one verdict: **accept**, **accept with document
changes**, or **pushback**. Document changes are *proposed* here and *applied*
in step 6, after the owner decides. Pushback is for a direct defect, a
security gap or a broken commitment. It is raised, not quietly accepted.

### 5. Owner decision, and pushback

For each finding, the owner chooses one of three:

- fix it now, in a fix round;
- send it to the backlog;
- accept it.

Pushback blocks the merge until it is resolved by a fix, by leaving the part
out of what comes home, or by an owner override. The override's reason goes to
`docs/decisions.md` and to the record item. This is the same `override`
pattern as Build Studio's other gates, and it applies to security too.

### 6–7. Apply, verify, merge

Fix rounds use `launchFixPlan` on the integration branch, and their findings
come back to the reviewers. Approved document changes are applied by their
roles, and backlog items are filed through `createItem`. Then the execution
run's second half runs as it does today: `qa_validation`, `security_audit`
(Sensitive tier), `owner_checks` with visual and interactive checks when the UI
changed, `merge_to_main` and `capture_learnings`. Project state and the
affected backlog items are updated, so ordinary development can continue.

## Artifacts

No new document types:

- **The record** is a backlog item of type Task, for example "Reconcile
  `<branch>`". It holds:
  - the source and target SHAs;
  - the inventory;
  - the risk tier and any reason it was lowered;
  - the decisions and overrides;
  - the verification;
  - the result.

  The integration branch is named after it.
- **The approved behaviour** is one or more PRDs.
- **Decisions** go to the Key Decisions Log.
- **Everything else** goes to the documents that already exist, only where
  needed: ADRs, `ARCHITECTURE.md`, UX specifications, the vision.

## The source after the merge

Build Studio never cleans up the source. The record says where the source
branch, worktree or clone is, and the owner removes it. The pinned ref in the
project's repository keeps the source revision traceable after it is gone.

## Increments

Each one is useful alone, as with the kickoff interview:

1. **The skill and the intake script.** The skill `reconcile_interview` lives
   in `templates/default/.claude/skills/`. The script produces the inventory:
   - the pin, the merge-base and the dry-run merge;
   - the path classes and the suggested tier;
   - the id collisions and the dirty-source refusal.

   Both can be used by hand. The first real case runs through all seven steps
   by hand, before any workflow code is written, so the design is tested on
   real work.
2. **The workflow type `reconcile`:** steps 1–6, handing over to the execution
   run's second half on the integration branch. An `ensure…Skill` copies the
   skill into projects onboarded before it existed.
3. **The hub:** a Reconcile button under Project, with a picker for a branch or
   a worktree and a field for the brief.

## Out of scope

- Partial take-home at hunk level.
- Automatic conflict resolution.
- A structured question form. The terminal interview is proven and keeps the
  back-and-forth.
- Cleaning up the source.
- Several sources in one run.

## Risks

- **Legitimising.** An agent writing requirements from code is the failure this
  flow exists to prevent. The skill's rule (acceptance criteria only from the
  owner's answers) is the guard. The PRD reviewer checks it.
- **Size.** An externally-iterated UI can touch hundreds of files, too many for
  one reviewer's context. Reviews are split by PRD or by area.
- **Binaries.** Design work brings source scenes, archives and video. Intake
  flags them by type and size, and the interview decides what belongs in git.
- **Long suites.** A full iOS suite can take over two hours. The tier decides
  what blocks the merge and what can become a backlog task.
- **Parallel truths.** A branch can bring its own handover file into the
  repository. A reviewer folds it into `docs/project-state.md` or removes it.
- **Continued work on the default branch** while the source is out. Id
  collisions grow until it is reconciled. Intake finds them; until then, the
  owner should know that new backlog items on the default branch will collide.

## Decisions taken (2026-11-01)

1. **Approved behaviour lives in PRDs**, so the execution run's second half and
   later drafting read it like everything else.
2. **The source must be committed.** Intake refuses a dirty source and lists
   what is uncommitted. No snapshot of uncommitted work is taken on the owner's
   behalf.
3. **Pushback blocks, and the owner can override with a reason**, which is
   logged. That includes security.
4. **The owner may lower the risk tier**, seeing its triggers and giving a
   reason, which is logged. Raising is always allowed.
5. **Build Studio never cleans up the source.** It reports where the source is.
6. **The first case runs by hand** on increment 1, before the workflow type and
   the UI are built.

## Verification

- Intake refuses a source with modified or untracked files and lists them. It
  accepts once they are committed.
- Intake against a separate clone pins the source SHA in the project's
  repository, and the pin survives the clone being deleted.
- A dry run that conflicts lists the conflicting paths. Nothing is merged.
- An id that the source and the target allocated in parallel is reported.
- A change that touches only copy is classed Light; one that touches CI or
  consent is classed Sensitive, with the triggers named.
- The interview opens by separating what the branch claims from what the code
  shows, and writes acceptance criteria only from the owner's answers.
- `merge_to_main` deletes `reconcile/<ID>`, never the source branch.
