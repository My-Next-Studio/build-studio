const fs = require('fs');
const path = require('path');

/**
 * Knowledge manifest (docs/knowledge.yaml) — the file that turns a repo's
 * layout into a declared, versioned knowledge surface. Spec:
 * docs/knowledge-manifest.md in the build-studio repo (shared by all Studio
 * applications).
 *
 * This module writes the default single-product manifest matching the
 * scaffold's standard layout. It never overwrites an existing manifest.
 */

function slugify(name) {
  return String(name || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';
}

function defaultManifestYaml({ id, name }) {
  return `# Knowledge manifest — maps this repo's knowledge to paths.
# Spec: https://github.com/My-Next-Studio/build-studio/blob/main/docs/knowledge-manifest.md
contract: 1

products:
  - id: ${id}
    name: ${JSON.stringify(name)}
    knowledge:
      vision: docs/vision.md
      project_state: docs/project-state.md
      architecture: ARCHITECTURE.md
      inputs: docs/inputs/
      prds: docs/prds/
      backlog: docs/backlog/
      learnings: docs/learnings/
      asset_register: docs/asset-register.md

owners:
  build-studio:
    - docs/
    - ARCHITECTURE.md
`;
}

/**
 * Write docs/knowledge.yaml for a project if absent.
 * Returns true when the file exists afterwards (created or already there),
 * false on failure — best-effort, never throws.
 */
function ensureManifest(targetPath, { name }) {
  try {
    const file = path.join(targetPath, 'docs', 'knowledge.yaml');
    if (fs.existsSync(file)) return true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, defaultManifestYaml({ id: slugify(name), name }));
    return true;
  } catch {
    return false;
  }
}

module.exports = { defaultManifestYaml, ensureManifest, slugify };
