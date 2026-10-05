# Plan: calibrated decisions over agent text, measured before they are trusted

> **Status: increments 1 and 2 implemented 2026-10-01, at one decision point; question set v3 2026-10-05**
> (proposed 2026-09-19). See *Where this stands* at the end.
>
> Owner request: evaluate the newly released "System One" class of decision
> models for use inside the engine, as a research project first — what is
> learned matters more than what is saved. The results are meant to be written
> up publicly, so the method has to be one worth reading about: measured, with
> the failures left in.

## The problem

The engine makes dozens of small judgements about text that agents wrote, and
almost all of them are regular expressions. Seven modules are, by their own
header comments, one question each:

| module | the question it asks |
|---|---|
| `gate-blocked.js` | could the check not run, or did it run and fail? |
| `exit-recovery.js` | did the agent finish and forget to report? |
| `agent-recovery.js` | is the agent dead, or merely slow? |
| `limit-block.js` | is it stuck, or waiting for a usage limit to reset? |
| `needs-attention.js` | can this run proceed without a human, and if not, why? |
| `builder-role-hint.js` | which implementation track does this PRD name? |
| `plan-contract.js` | does this output satisfy its contract? |

`api/workflow.js` adds a couple of hundred more pattern matches over feedback,
pane captures and transcripts.

Regex is the right tool when the agent follows the format and the wrong one
when it does not, and an agent is a writer, not a serializer. Two failures in
one week (2026-09) were exactly this class:

- **A negative read as a positive.** A verification agent finished a clean run
  with one real finding, and also filled in the "gate could not run" marker with
  "N/A — suite executed fully". Any non-empty text counted as a blocker, so the
  run stalled and the message told the owner to fix an environment the agent had
  just certified. The fix was a longer list of words that mean "no".
- **A progress note read as a final report.** The watchdog flagged an agent as
  finished-but-unreported and offered to deliver its "report". The text said, in
  so many words, that a long test run was still in progress and that feedback
  would follow when it finished. Delivering it would have advanced the step on
  half a result.

In both cases the answer was in plain language in the text. A pattern could not
read it; any reader could.

A third case has no regex at all because none is possible: telling an agent that
is *working* from one *waiting at a menu* from a pane capture. The drafting
session needed that distinction and did without it.

## What System One models are, and what is actually known

TypeSafe's Jev (released 2026-09) is the first public model of the class. It
does not generate text. A request carries a `state` (string, object or array)
and a map of typed questions; each answer is a typed value with probabilities:

- **Noul** — a statement, answered with P(true).
- **Choice** — one of a declared set of options, with the full distribution and
  a confidence value.
- **Score** — a level on an ordered rubric, with distribution and confidence.

All questions in a request are evaluated in parallel and in isolation, so adding
questions barely changes latency. The vendor's training method (RLCD) optimises
for *calibration* — answers given 90% should be right about 90% of the time —
rather than for text humans prefer.

Vendor-stated figures: 70–500 ms end to end; $0.042 per million input tokens,
output free; 64k context, 32k for state; text only, English strongest; hosted,
closed weights, early access by waitlist.

What to hold against that, all from the vendor's own material or independent
coverage:

- **It is less accurate than large models on the vendor's own workflow evals**
  (67.8% against 73–74% for the strongest general models, where the reference
  labels are an average of two frontier models at high reasoning effort).
  Cheaper and faster, not as good.
- **"Cannot hallucinate" means schema-valid, not correct.** A typed answer can
  be the wrong answer.
- **Confidence is derived from the shape of the distribution**, not an
  independent signal, and Noul answers carry none.
- **No independent verification exists yet.** Every number above is the
  vendor's.
- **Documented weaknesses** (model card, "jaggedness"): literal reading of the
  question; counting, numbers and dates; double negatives and multi-hop
  reasoning; accuracy falling as irrelevant state grows; state is *not* treated
  as hostile, so text inside it can steer the answer; probabilities from
  separate questions are not guaranteed comparable.

## The idea worth keeping is the shape, not the vendor

`state in → typed answer with a probability out` is a better interface for the
engine's judgements than `text in → regex → boolean`, whoever answers it:

- the question is written down in words, next to the code that acts on it;
- the answer carries its own uncertainty, which a regex never does;
- an uncertain answer has somewhere to go — the owner — instead of silently
  becoming `false`.

The vendor publishes an MIT-licensed adapter that exposes the same interface
over ordinary LLM APIs. That makes the shape testable today, with a small
general model behind it, and swappable for a System One model when access
arrives. Nothing below depends on the waitlist.

## Increments

Each is useful alone, and each earns the next.

1. **A decision layer with the System One shape.** `lib/decide.js`:
   `decide({ state, questions }) → answers`, with Noul / Choice / Score, and a
   provider interface behind it. First provider: a small general model through
   an API already in use. The adapter is Python-only, so this is a small Node
   equivalent rather than a dependency. State is always the *narrowest* text
   that contains the answer — the last message, not the transcript — because
   irrelevant state is a documented accuracy cost and a privacy one.

2. **Shadow mode.** The layer runs beside the existing logic at each of the
   seven decision points, and *never acts*. Both answers are appended to a
   JSONL log with the input. Disagreements are the dataset; agreement is the
   baseline. The two incidents above become the first regression cases.

3. **Measure calibration on our own questions.** The vendor's evals measure
   accuracy against a consensus label, not calibration. The engine has history
   with known outcomes — a gate that was overridden, an alert that turned out
   false, a recovered report that was or was not final. Bucket answers by stated
   probability and compare with what happened. Whether "0.9" means 0.9 *on these
   questions* is the part nobody has published, and the part worth writing up.

4. **Confidence-gated routing, one decision point at a time.** Only where
   increment 3 shows calibration holds. High confidence acts; low confidence
   goes to the owner with the question and the distribution shown. This is the
   existing gate ladder — advisory instruction, deterministic refusal, review
   gate — with a probability deciding the rung instead of a pattern.

5. **A second provider.** Add the System One model behind the same interface
   and re-run increment 3 against the identical log. The comparison —
   latency, cost, calibration, per question — is the publishable result either
   way, including if the answer is "not yet".

## What stays in code

- **Anything numeric.** Test counts, round numbers, durations. Counting and
  number handling are documented weaknesses, and a regex over `N/M` is exact.
- **Blocking gates keep their deterministic rule as primary.** State is not
  treated as hostile, and agent output is text an agent chose. The decision
  layer is a second opinion on a block, never the only one.
- **Anything that must work offline or without a key.**

## Risks that need a decision

1. **Data leaves the machine to a new recipient.** The state for these
   decisions is agent output from managed projects. Increments 1–4 add no new
   recipient, since they use a provider already in use; increment 5 does.
2. **Non-English content.** Accuracy is documented as lower outside English, and
   managed projects are not all English.
3. **A hosted dependency in a control path.** The layer must fail *open to the
   existing logic*, never closed: an outage in a judgement service must not
   become an outage in the engine.
4. **Literal reading cuts both ways.** A question that is slightly wrong is
   answered exactly as written. Questions are code and need review and tests
   like code.

## Explicitly out of scope

- Replacing the agents' own reasoning. These are the engine's judgements *about*
  agents, not the agents' work.
- Model routing per step on a classifier's say-so. Plausible, and a different
  plan: it changes what runs, not how a result is read.
- Acting on any probability before increment 3 has measured it.

## Verification

- The layer, asked whether the "N/A — suite executed fully" feedback reports a
  check that could not run, answers no; asked about a genuine "no browser is
  available", answers yes. Both directions, since the expensive error is
  swallowing a real blocker.
- Asked whether the in-progress note is a final report, it answers no.
- With the provider unreachable, every decision point behaves exactly as it does
  today, and the failure is logged once rather than per call.
- The shadow log can reproduce, offline, every answer it recorded.
- A reliability table exists per question, with the number of cases behind each
  bucket shown — a calibration claim over a dozen cases is not a claim.

## Sources

- https://typesafe.ai/blog/introducing-system-one-models-and-jev
- https://docs.typesafe.ai/ (primitives, confidence, state, models, API)
- https://docs.typesafe.ai/model-jaggedness/jev-1.13.md
- https://evals.typesafe.ai/
- https://github.com/typesafe-ai/system-one-adapter-python
- https://www.theregister.com/ai-and-ml/2026/09/16/typesafe-ai-debuts-model-for-machines-that-plays-doom/5296711

## Where this stands (2026-10-01)

### Decisions taken

1. **The System One model is the first provider, not the last.** Access stopped
   needing the waitlist: OpenRouter serves Jev on a decisions endpoint
   (`/api/alpha/decisions`) that takes the native request shape and returns the
   typed answers, distributions and confidence unchanged. Increment 5's order is
   reversed: a general-model provider becomes the comparison, added later.
2. **Pinned version.** `typesafe/jev-1.13`, not the `jev-latest` alias. The shadow
   log is a calibration dataset; an alias would change the model under it.
3. **Through OpenRouter rather than direct.** It is already a recipient of agent
   traffic here (opencode), and its key is already read. Costs accepted: the
   endpoint is alpha, there is one more hop, and two parties see the state
   instead of one.
4. **On for every managed project once enabled, with per-project opt-out.** The
   calibration measurement needs breadth; a reliability claim over a dozen cases
   is not a claim.
5. **Non-English state is sent, and the language is recorded.** Shadow mode never
   acts, so a weaker answer costs nothing, and the size of the gap becomes a
   measured result rather than an assumption.
6. **The shadow log lives under `~/.build-studio/decisions/`, not in managed
   projects.** A log in a project repo would need a `.gitignore` change in every
   project, and a modified `.gitignore` blocks the next execution run.

### Built

- **Increment 1.** `lib/decide.js`: `decide({ state, questions })` with Noul /
  Choice / Score, one provider (OpenRouter), off unless `decisions.enabled` is set
  in the installation config, a 8 s timeout, and failures that return null and are
  logged once per kind.
- **Increment 2, one decision point.** `gate_blocked`: every report delivered by
  a verification step is asked the question in `gate-blocked.js`
  (`SHADOW_QUESTIONS`) beside `parseGateBlocked`, and both answers are appended to
  the shadow log with the state, the model version, latency, cost and detected
  language. Called once per delivered report, never from code that runs per poll.

### First measurement (synthetic, three cases)

Both verification directions hold on the live model: the "N/A — suite executed
fully" report scored P(could not run) = 0.04, a genuine "No browser is available"
0.93, and a Swedish report of a clean run 0.04. 270–660 ms per call, about
$0.00002 each. Three cases are a smoke test, not a calibration result.

### First day of shadow data (2026-10-02, 63 reports)

- The model and the regex agreed on 53. In all 10 disagreements the model said a
  check could not run and the regex said none did; the regex flagged nothing all
  day. Median 0.57 s, p90 0.65 s, $0.0036 in total. Every report was English.
- **One real catch:** a review saying its verification "was blocked by the
  normal-build guard", in prose and without the marker line. The regex cannot
  see that. This is the case the plan was written for.
- **The main error was the question, not the model.** Two reviews saying checks
  "were not executed during this review" (a scope choice) scored 0.70 and 0.91:
  the question mixed *a check was not run* with *the environment stopped it*.
  The rest sat near 0.5 (security audits noting no live provider calls, AC rows
  marked untestable/manual, "evidence pending"), which is the uncertainty they
  deserve.
- **The question was split, not replaced.** `could_not_run` is kept word for word
  so its data stays comparable. Two single-condition questions were added:
  `not_executed` and `environment_cause`. Re-asked on the same reports,
  `environment_cause` scored the build-guard block 0.91 and the scope choice
  0.07, with the second scope case at 0.42. The old synthetic cases still hold
  (the "N/A" marker 0.03, "No browser is available" 0.96). The extra questions
  cost almost nothing: they are answered in parallel, and output is free.

### Days two to four (2026-10-03 to 10-05, 125 reports on the split questions)

- `environment_cause` agreed with the regex on 115. The regex flagged 3 reports,
  and the model agreed on all 3. Errors: 0. Median 0.59 s, p95 6.5 s; $0.012
  across all 208 reports since the start. All English.
- Of the 10 disagreements, the model was right on 2 (another build-guard block
  in prose; a broad suite stopped mid-run). 1 was borderline (E2E skipped by
  instruction, plus a known local keychain limitation). It was wrong on 7. Every
  one of the 7 was a test that ran and failed, or timed out and passed on a
  rerun. The criteria listed "timed out" as an environment cause, and the model
  read that literally. Same class of error as day one: the wording, not the
  model.
- **Question set v3 (2026-10-05).** `environment_cause` now says that a test
  that ran and failed, timed out, or passed on a rerun produced a result. A
  timeout counts only when the environment is what timed out. Every record now
  carries `questionsVersion`; untagged records are v1 (no `environment_cause`)
  or v2. Replayed on the same 14 reports: 6 of the 7 errors fell below 0.5
  (0.86 → 0.69 stayed above). Both real catches held (0.94; 0.52, now
  borderline), as did all three regex-flagged reports (0.83–0.93). Compare v2
  and v3 on live data, not on this replay, before judging the trial.

### Open

- The other six decision points.
- **Candidate decision point: support triage verdict** (owner request
  2026-10-01, to take up only if the gate trial looks promising). Triage is an
  agent that investigates a report read-only and writes a proposal: a verdict
  (`invalid`, `duplicate`, `bug`, `bug_prd_scale`, `feature`, `task`), a
  severity, and the item's text. The model cannot replace that. It does not
  generate text or read the repo. But the verdict at the end is a Choice and
  the severity a two-level Choice, asked of the report plus the agent's
  findings as state.

  Two reasons it is worth doing:
  - **It has ground truth.** Every proposal ends in an owner decision (filed,
    rejected, dismissed as duplicate), so calibration is measured against real
    judgments, with no hand labelling. No other decision point has that.
  - **It has the one triage outcome that acts unattended.** A `bug` verdict
    files itself without approval. If calibration holds, a confident agreement
    could keep that, and anything less could wait for the owner. That is
    increment 4's confidence-gated routing on a decision that matters.

  Kept out: duplicate detection by sending the backlog as state. A long
  backlog is mostly irrelevant state for any one report, which is a documented
  accuracy cost, and it runs into the 32k state limit. The agent's search on
  symptom stays. Start in shadow mode: log the model's verdict beside the
  agent's and the owner's eventual decision.
- Increment 3 (calibration against known outcomes) once the log has enough cases.
