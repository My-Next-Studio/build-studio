/**
 * electron-builder afterPack hook.
 *
 * The hub UI is served by the Next.js standalone build, which electron-builder
 * cannot package itself (its node_modules filtering breaks the standalone
 * layout). Historically the copy happened only in a separate inject-resources
 * step — so `electron-builder --dir` alone produced a .app with no hub server
 * that launched to a black window. This hook folds the injection into every
 * package run and fails the build hard if the result is incomplete.
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

module.exports = async function afterPack(context) {
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const resources = path.join(context.appOutDir, appName, 'Contents', 'Resources');

  const standaloneSrc = path.join(__dirname, '..', '..', 'hub', '.next', 'standalone');
  if (!fs.existsSync(standaloneSrc)) {
    throw new Error(
      'Hub standalone build not found — run "npm run build:next" (next build in packages/hub) before packaging. ' +
      'Without it the app would launch to a black window.'
    );
  }

  console.log('  • afterPack: injecting hub standalone into the app bundle');
  execFileSync('node', [
    path.join(__dirname, '..', 'inject-resources.js'),
    `--app-resources=${resources}`,
  ], { stdio: 'inherit' });

  const server = path.join(resources, 'standalone', 'packages', 'hub', 'server.js');
  if (!fs.existsSync(server)) {
    throw new Error(`afterPack verification failed: ${server} is missing — refusing to produce an unlaunchable app.`);
  }
};
