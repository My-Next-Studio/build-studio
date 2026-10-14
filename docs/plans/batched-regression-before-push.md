# Plan: a regression run per batch of stories, before the push

> **Status: proposed 2026-10-14.** Nothing here is built yet.
>
> Owner request: stop paying for a regression suite on every story. Build a
> series of stories and tasks, then run one regression before pushing to
> main. A few issues may slip past the per-story runs, but the batch run
> catches them before they leave the machine.

## Where this starts from

The per-story cost has already come down, in stages:

- **XCUITests:** `qa_validation.scope: new-uitests` runs only the UI-test
  classes a branch adds or modifies. The full UI suite already runs once per
  batch, by hand, from the Operations → UITests tab before a push. This plan
  generalises that habit.
- **The native suite** is skipped when a branch changes nothing the app
  builds from.
- **JS/TS tests:** `qa_validation.js_scope: changed` (2026-10-12) runs the
  test files a branch adds or modifies plus the tests related to its changed
  sources (`vitest related`, `jest --findRelatedTests`). Before it, QA ran the
  whole JS suite on every story: about 40 minutes on one project for a
  one-file change, repeating what that project's CI runs on the pull request.

So the remaining per-story test cost is minutes, not the hour it was. Going
from "related tests" to "no tests" per story saves little more; the case for
this plan is less about speed now and more about making the batch the place
where the full suites run, deliberately.

## Recommendation

Keep the scoped tests per story, and make the batch regression a real step
rather than a manual habit.

### 1. Per story: scoped tests stay

The related-tests run catches direct breakage while the builder that caused
it is still running, with its context. That is the cheapest moment to fix
anything. Dropping it entirely is what turns a five-minute fix into a triage.

### 2. Per batch: a regression step that names the guilty story

A run (or a work-queue entry) that, on demand:

1. Runs every full suite the per-story scope skipped: the JS suite, the native
   suite, the full XCUITest regression.
2. On a failure, finds the story that introduced it. Every story lands on the
   main branch as one merge commit, so testing the failing tests at each merge
   commit since the last push (a bisect over merges, not over every commit)
   is cheap, and only the failing tests need running.
3. Files one bug per failure, linked to the story that caused it, with the
   failing output. The existing bugfix workflow takes it from there.

The attribution in step 2 is what makes batching safe. Without it the batch
run says "something broke somewhere in the last N stories", the agents that
wrote them are gone, and someone has to reconstruct which merge did it.

### 3. Run the batch in CI where the project allows it

A project whose CI runs the full suites on pull requests can run the batch
there: push a batch branch, open a pull request, and read the result back
(the CI/CD tab already monitors runs). That uses CI's machines, in parallel,
instead of holding a 16 GB development machine for 40 minutes. The local run
remains for what CI does not cover the same way, typically the simulator's
XCUITest regression.

### 4. The work queue is the natural place for it

Queue five stories, then a regression entry. The entry is ready when the
entries above it have finished, and its result (green, or the bugs it filed)
is what the owner reads before approving the push.

## Downsides and how the design answers them

| Risk | Why it matters | Answer |
|---|---|---|
| Late discovery | A failure is found after the story's builder has exited, so the fix needs a new run with no context | Scoped tests per story catch direct breakage early; attribution (step 2) gives the new run the story and the failing output |
| Compounding | A later story builds on an earlier broken one, and may work around or "fix" the breakage in the wrong place | Same: related tests reach the shared code each story touches. Local main is still only as trustworthy as the per-story scope |
| "Pre-existing" becomes a loophole | QA reports a failing test unrelated to the branch as pre-existing and non-blocking. With no full runs between pushes, a regression from story 2 reads as pre-existing in story 3 and is waved through every time | The batch run is the backstop, and it must compare against the last pushed main, not against the previous story, so that a failure introduced inside the batch is never classed as pre-existing |
| Bigger, rarer pushes | More to untangle when the batch fails | Attribution per failure; and the owner chooses the batch size |

## Open questions

- Whether the regression step is a new workflow type, a work-queue entry kind,
  or an Operations action that the queue can call.
- How a project declares which suites its CI covers, so the local batch run
  skips those.
- Whether a red batch blocks the push in the hub, or only reports.

## Ruled out

- **No tests at all per story.** The time saved over the scoped run is small
  now, and it removes the only check that runs while the builder still has
  its context.
