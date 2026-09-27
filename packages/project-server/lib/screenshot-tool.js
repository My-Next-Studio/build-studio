'use strict';

// A project-supplied way to see its own UI.
//
// QA's visual smoke and a builder's self-check both need a rendered screen.
// Build Studio knows two ways to get one: a browser (`features.playwright_cli`)
// and an iOS simulator. A desktop app has neither, so its QA step was declared
// "visual smoke: NOT APPLICABLE" and no agent ever looked at a screen it built.
// For launch-studio (Electron) that went on for 77 PRDs, and layout defects —
// buttons stretched to the window width, a header grown by accretion, dialogs
// with no chrome — were found only by the owner, one at a time.
//
// `features.screenshot_command` lets the project provide the capture itself,
// with its own harness (for Electron, Playwright's `_electron`). Protocol, run
// from the project root:
//
//   <command> list                  one view id per line; "id<TAB>description" allowed
//   <command> <view-id> <out.png>   render that view and write a PNG; exit 0
//
// Anything the harness needs (a seeded product, a data directory, a window
// size) is the harness's business. A view that needs arguments is a separate id.

function resolveScreenshotCommand(config) {
  const raw = config && config.features && config.features.screenshot_command;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** QA: how to capture and what to do with the result. */
function qaScreenshotInstructions(command, prdBasename) {
  const dir = `docs/pr-evidence/${prdBasename || '<PRD-basename>'}/visual`;
  return `\n   - **Use the project's screenshot command for this** — there is no browser or simulator here, and none is needed:`
    + `\n     \`${command} list\` prints the screens it can render; \`${command} <view-id> ${dir}/<view-id>.png\` renders one to a PNG.`
    + `\n     Capture every view this PRD adds or changes, then **open each PNG and look at it** (Read the file — you can see images).`
    + ` A capture you did not look at is not a check. Inspect for: controls stretched to the container width, overlapping or clipped`
    + ` elements, a region that grows with its content and pushes the rest off-screen, unstyled elements (a raw dialog, a button with`
    + ` no button class), missing states (empty, loading, error), text that does not fit, and anything that contradicts the UX spec or`
    + ` the design bundle (\`design-system/\`). Each is a finding with the screenshot path as evidence.`
    + `\n     If the command itself fails, report its exact output on a \`**Gate could not run:**\` line — that is an environment problem,`
    + ` not a defect. If a changed screen has no view id, that is a finding against the harness: name the screen.`;
}

/** Builders of UI: check your own screens before saying done. */
function builderScreenshotInstructions(command) {
  return `\n\n## LOOK AT WHAT YOU BUILT (REQUIRED before reporting done)\n\n`
    + `Tests assert what is in the DOM, not what it looks like. Before reporting a UI change done, render it:\n\n`
    + '```bash\n'
    + `${command} list                          # the screens the harness can render\n`
    + `${command} <view-id> /tmp/<view-id>.png  # render one\n`
    + '```\n\n'
    + `Open each PNG (Read it) and check it against the UX spec and the design system: nothing stretched to the full container width`
    + ` unless the spec says so, nothing overlapping or clipped, spacing from the design tokens, the new element placed where the spec`
    + ` puts it. Fix what you see before reporting. If the screen you changed has no view id, add one to the harness in the same task.`;
}

module.exports = { resolveScreenshotCommand, qaScreenshotInstructions, builderScreenshotInstructions };
