'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tidyMarkdown } = require('./markdown-tidy');

// fazon FAZ-382: a list straight under a bold lead-in failed MD032, and the
// project's pre-commit docs lint refused Support's auto-commit.
test('a list right under a bold lead-in gets a blank line (MD032)', () => {
  assert.equal(tidyMarkdown('**Observed:**\n- one\n- two'), '**Observed:**\n\n- one\n- two');
  assert.equal(tidyMarkdown('Steps:\n1. a\n2. b'), 'Steps:\n\n1. a\n2. b');
});

test('headings and fences get blank lines around them (MD022, MD031)', () => {
  assert.equal(tidyMarkdown('text\n## Head\nmore'), 'text\n\n## Head\n\nmore');
  assert.equal(tidyMarkdown('text\n```js\nx\n```\nafter'), 'text\n\n```js\nx\n```\n\nafter');
});

test('code inside fences is left exactly as it is', () => {
  const src = '```\n**b:**\n- not a list\n\n\n# not a heading\n```';
  assert.equal(tidyMarkdown(src), src);
});

test('nested items, continuations and already-tidy text are unchanged', () => {
  const tidy = '**Lead:**\n\n- item\n  - nested\n  continuation\n- item two\nlazy continuation';
  assert.equal(tidyMarkdown(tidy), tidy);
});

test('runs of blank lines collapse to one (MD012)', () => {
  assert.equal(tidyMarkdown('a\n\n\n\nb'), 'a\n\nb');
});

test('support files agent bodies through the tidier and tells the agent the rule', () => {
  const src = fs.readFileSync(path.join(__dirname, 'api', 'support.js'), 'utf8');
  assert.match(src, /body = tidyMarkdown\(body\);/);
  assert.match(src, /passes a docs linter: a blank line before every list/);
});
