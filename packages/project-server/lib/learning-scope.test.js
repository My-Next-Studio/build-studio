const { test } = require('node:test');
const assert = require('node:assert/strict');
const { learningStacks, detectProjectStacks, isLearningEligible } = require('./learning-scope');

// The four real offenders, and the two real projects they were reaching.
const SVELTE = ['svelte', 'svelte5', 'bind', 'reactive', 'hidden-input', 'testing'];
const NEXT_MDX = ['mdx', 'next.js', '@next/mdx', 'compile', 'shiki', 'consistency'];
const GENERAL = ['consistency', 'derived-value', 'refactor', 'testing'];

const FAZON = detectProjectStacks({ hasSwift: true });                  // iOS
const LAUNCH_STUDIO = detectProjectStacks({ jsDeps: ['react', 'electron'] });

test('a general learning reaches every project', () => {
  // The best-performing entries here are all general (18-29% applied). None of
  // them may ever be filtered out.
  assert.equal(learningStacks(GENERAL).size, 0);
  assert.equal(isLearningEligible(GENERAL, FAZON), true);
  assert.equal(isLearningEligible(GENERAL, LAUNCH_STUDIO), true);
  assert.equal(isLearningEligible([], FAZON), true);
});

test('framework trivia stops reaching projects without the framework', () => {
  assert.equal(isLearningEligible(SVELTE, FAZON), false);
  assert.equal(isLearningEligible(SVELTE, LAUNCH_STUDIO), false);
  assert.equal(isLearningEligible(NEXT_MDX, FAZON), false);
});

test('swift learnings reach the iOS project and not the Electron one', () => {
  const swift = ['swift', 'xctest', 'concurrency'];
  assert.equal(isLearningEligible(swift, FAZON), true);
  assert.equal(isLearningEligible(swift, LAUNCH_STUDIO), false);
});

test('react learnings reach the React project', () => {
  assert.equal(isLearningEligible(['react', 'hooks'], LAUNCH_STUDIO), true);
  assert.equal(isLearningEligible(['react', 'hooks'], FAZON), false);
});

test('a Next.js project counts as a React project', () => {
  const nextProject = detectProjectStacks({ jsDeps: ['next', 'react'] });
  assert.equal(isLearningEligible(['react'], nextProject), true);
  assert.equal(isLearningEligible(NEXT_MDX, nextProject), true);
});

test('an undetectable stack hides nothing', () => {
  // Fail open. Withholding a relevant learning surfaces weeks later as a
  // repeated mistake; showing an irrelevant one costs a sixth of a prompt.
  const unknown = detectProjectStacks({});
  assert.equal(unknown.size, 0);
  assert.equal(isLearningEligible(SVELTE, unknown), true);
  assert.equal(isLearningEligible(['swift'], unknown), true);
  assert.equal(isLearningEligible(SVELTE, null), true);
});

test('cross-stack tags are eligible if ANY stack matches', () => {
  const both = ['swift', 'react', 'api-contract'];
  assert.equal(isLearningEligible(both, FAZON), true);
  assert.equal(isLearningEligible(both, LAUNCH_STUDIO), true);
});

test('generic words are not treated as stack markers', () => {
  // 'testing', 'api', 'ci' appear on every stack. Treating them as markers
  // would misclassify general lessons as specific ones — the wrong direction.
  for (const t of [['testing'], ['api', 'ci'], ['performance'], ['database', 'sql']]) {
    assert.equal(learningStacks(t).size, 0, `${t} must not be a stack marker`);
  }
});

test('tags are matched case- and whitespace-insensitively', () => {
  assert.equal(isLearningEligible([' Swift ', 'XCTest'], LAUNCH_STUDIO), false);
  assert.equal(isLearningEligible([' Swift '], FAZON), true);
});

test('malformed tags do not throw or accidentally filter', () => {
  assert.equal(isLearningEligible(null, FAZON), true);
  assert.equal(isLearningEligible(['', null, undefined], FAZON), true);
  assert.equal(isLearningEligible('not-an-array', FAZON), true);
});

// ─── Detection from disk ─────────────────────────────────────────────────────

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectStackEvidence } = require('./learning-scope');

function makeRepo(layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-stack-'));
  for (const [rel, body] of Object.entries(layout)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (rel.endsWith('/')) fs.mkdirSync(abs, { recursive: true });
    else fs.writeFileSync(abs, body);
  }
  return root;
}

test('a manifest two levels down still counts — the fazon case', () => {
  // Root-only detection concluded "no Python" for a repo whose Python lives in
  // tools/remote-config/, and filtered out that project's OWN Python learnings.
  const root = makeRepo({
    'ios/App.xcodeproj/project.pbxproj': '',
    'tools/remote-config/pyproject.toml': '[project]\nname="x"\n',
    'README.md': '#',
  });
  const stacks = detectProjectStacks(collectStackEvidence(root, fs));
  assert.equal(stacks.has('python'), true, 'python two levels down must be found');
  assert.equal(stacks.has('swift'), true, '.xcodeproj is a directory, not a file');
  assert.equal(isLearningEligible(['python', 'regex'], stacks), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('dependencies are unioned across sub-packages', () => {
  const root = makeRepo({
    'package.json': '{"devDependencies":{"electron":"1"}}',
    'admin/package.json': '{"dependencies":{"react":"18"}}',
    'worker/package.json': '{"dependencies":{"svelte":"5"}}',
  });
  const stacks = detectProjectStacks(collectStackEvidence(root, fs));
  assert.equal(stacks.has('react'), true);
  assert.equal(stacks.has('svelte'), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('node_modules is not scanned', () => {
  // Otherwise every project "has" every stack, and the filter does nothing.
  const root = makeRepo({
    'package.json': '{"dependencies":{"electron":"1"}}',
    'node_modules/svelte/package.json': '{"dependencies":{"svelte":"5"}}',
  });
  const stacks = detectProjectStacks(collectStackEvidence(root, fs));
  assert.equal(stacks.has('svelte'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unreadable or empty repo yields no stacks, and so hides nothing', () => {
  const stacks = detectProjectStacks(collectStackEvidence('/nonexistent-path-xyz', fs));
  assert.equal(stacks.size, 0);
  assert.equal(isLearningEligible(['swift'], stacks), true);
});
