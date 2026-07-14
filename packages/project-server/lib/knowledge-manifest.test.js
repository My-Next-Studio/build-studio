const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { defaultManifestYaml, ensureManifest, slugify } = require('./knowledge-manifest');

test('slugify: name → stable id', () => {
  assert.equal(slugify('My App'), 'my-app');
  assert.equal(slugify('Välkomna!'), 'v-lkomna');
  assert.equal(slugify(''), 'project');
});

test('default manifest is valid YAML with contract, product, owners', () => {
  const doc = yaml.load(defaultManifestYaml({ id: 'my-app', name: 'My App' }));
  assert.equal(doc.contract, 1);
  assert.equal(doc.products[0].id, 'my-app');
  assert.equal(doc.products[0].name, 'My App');
  assert.equal(doc.products[0].knowledge.vision, 'docs/vision.md');
  assert.ok(doc.owners['build-studio'].includes('docs/'));
});

test('ensureManifest: creates once, never overwrites', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-'));
  assert.equal(ensureManifest(dir, { name: 'Proj X' }), true);
  const file = path.join(dir, 'docs', 'knowledge.yaml');
  fs.writeFileSync(file, 'contract: 1\n# custom\n');
  assert.equal(ensureManifest(dir, { name: 'Proj X' }), true);
  assert.match(fs.readFileSync(file, 'utf8'), /# custom/);
});
