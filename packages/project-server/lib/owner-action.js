'use strict';

// A blocking finding that only the owner can clear.
//
// Some review findings are not development work at all: "AC-7 needs a real
// sandbox purchase on a physical device", "log in to the store console and
// accept the agreement". The fix planner correctly plans no agent task for
// them, and a gate built to catch planners that dodge findings ("0 tasks
// against a blocker is usually rationalisation") then blocked the run with an
// error that pointed at the planner, while the planner's own explanation of
// what the owner had to do sat unread in its report (fazon FAZ-272,
// 2026-09-30).
//
// The planner is asked to put such steps under a `### Owner action required`
// heading. This finds that section, and also the looser forms planners have
// written before the heading existed (`**Owner action (not dispatched):** …`).

const HEADING = /^(#{2,4})[ \t]*owner actions?\b[^\n]*$/im;
const BOLD = /^[ \t]*\*\*owner actions?\b[^*\n]*\*\*:?[ \t]*/im;

function extractOwnerAction(text) {
  const src = String(text || '');
  const h = HEADING.exec(src);
  if (h) {
    const level = h[1].length;
    const rest = src.slice(h.index + h[0].length);
    // Until the next heading of the same or a higher level, or a fenced block.
    const stop = new RegExp(`^(#{1,${level}}[ \\t]|\`\`\`)`, 'm').exec(rest);
    const body = (stop ? rest.slice(0, stop.index) : rest).trim();
    return body || null;
  }
  const b = BOLD.exec(src);
  if (b) {
    const rest = src.slice(b.index + b[0].length);
    // The paragraph and any list that follows it, up to a heading, a fence or
    // the next bold lead-in.
    const stop = /^(#{1,6}[ \t]|```|[ \t]*\*\*[A-Z])/m.exec(rest);
    const body = (stop ? rest.slice(0, stop.index) : rest).trim();
    return body || null;
  }
  return null;
}

module.exports = { extractOwnerAction };
