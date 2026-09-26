'use strict';

// A workflow records its PRD path once, when it starts. A PRD can be renamed
// while the run is in flight — renumbered after a collision with another PRD
// drafted the same day, retitled in a review round — and the backlog item's
// `prd:` field is updated with it. The run's copy is not, so every later step
// reads a file that is gone. The companion_specs step then reported the PRD as
// having "no §10 Companion Specs section" when it had one (fazon, 2026-09-26),
// and sent the owner looking for a missing table instead of a moved file.
//
// The backlog item is the source of truth for which PRD belongs to it. When the
// recorded path is gone and the item names an existing one, follow the item.

const fs = require('fs');
const path = require('path');

function prdFieldOf(itemFile) {
  let src;
  try { src = fs.readFileSync(itemFile, 'utf8'); } catch (_) { return null; }
  const fm = /^---\n([\s\S]*?)\n---/.exec(src);
  if (!fm) return null;
  const m = /^prd:\s*(.+)$/m.exec(fm[1]);
  if (!m) return null;
  const v = m[1].trim().replace(/^['"]|['"]$/g, '');
  return v && v !== 'null' && v !== '~' ? v : null;
}

/**
 * @returns {{ changed: boolean, from?: string, to?: string, missing?: boolean }}
 *   `missing` when the recorded file is gone and the item names nothing better.
 */
function reconcilePrdPath(wf, { projectRoot, docsPath }) {
  if (!wf || !wf.prdPath || !projectRoot) return { changed: false };
  if (fs.existsSync(path.join(projectRoot, wf.prdPath))) return { changed: false };
  const itemId = wf.itemId;
  if (!itemId || !docsPath) return { changed: false, missing: true };
  const named = prdFieldOf(path.join(docsPath, 'backlog', `${itemId}.md`));
  if (!named) return { changed: false, missing: true };
  // The field is written relative to the project root (docs/prds/…); accept a
  // bare file name too.
  const candidates = [named, path.posix.join(path.relative(projectRoot, docsPath), 'prds', path.basename(named))];
  const found = candidates.find((c) => fs.existsSync(path.join(projectRoot, c)));
  if (!found || found === wf.prdPath) return { changed: false, missing: true };
  const from = wf.prdPath;
  wf.prdPath = found;
  return { changed: true, from, to: found };
}

module.exports = { reconcilePrdPath, prdFieldOf };
