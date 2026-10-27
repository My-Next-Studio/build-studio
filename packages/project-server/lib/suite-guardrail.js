'use strict';

/**
 * One rule against test-suite drift, in the words each kind of agent needs.
 *
 * Every step of a workflow is scoped to one PRD, so a suite only ever grows:
 * each PRD adds its own gate, performance or Lighthouse-style test for the
 * surface it built, and nobody consolidates. One managed project's CI reached
 * two to three hours for a small site that way, with the same pages audited
 * several times per push.
 *
 * The rule is cheap and local: before adding a suite-wide check, look for one
 * that already covers the surface and extend it. Builders are told to do it;
 * reviewers are told to flag a duplicate as MEDIUM, not BLOCKING. A second
 * Lighthouse pass costs minutes, not correctness. The periodic maintenance
 * pass (docs/plans/test-suite-drift.md) handles what slips through anyway.
 */

/** The kinds of check this is about. Unit tests are not: they are cheap and per-feature by nature. */
const SUITE_WIDE = 'gate, performance, Lighthouse/accessibility audit, visual snapshot sweep, or any other check that runs across many pages or the whole app';

/** For the agent that writes tests (builder tasks and the TDD test writer). */
const BUILD_RULE = `**Extend, don't add, suite-wide checks.** Before adding a ${SUITE_WIDE}, look for an existing one that already covers this surface (same pages, same metric, same CI job) and extend it with this PRD's cases. Add a new one only when no existing check can take them, and say why in your feedback. Each PRD adding its own gate is how a suite grows to hours.`;

/** For code reviewers and the final reviewer. */
const REVIEW_RULE = `**SUITE GROWTH** — a new ${SUITE_WIDE}, or a new CI step, that covers a surface an existing one already covers is a MEDIUM finding: name the existing test or step it should extend instead. Not BLOCKING: it costs CI time, not correctness.`;

/** For PRD reviewers: PRDs are where a new gate is usually asked for. */
const PRD_REVIEW_RULE = `**Suite growth.** If the PRD asks for a new ${SUITE_WIDE} where the project already has one covering that surface, raise a MEDIUM finding proposing that the existing one be extended instead.`;

module.exports = { BUILD_RULE, REVIEW_RULE, PRD_REVIEW_RULE };
