# Plan: calibrated decisions over agent text, measured before they are trusted

> **Status: proposed 2026-09-19.**
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
