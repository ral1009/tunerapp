// Lets the app import the web app's plain-TypeScript modules (pitch detection, grading, score
// following) from the repo root instead of copying them -- both apps share one implementation.
// Only those folders are watched: the repo also holds a Python virtualenv and test recordings.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..');

// The score engine page (score/engine) is bundled into src/score/engineHtml.generated.ts. Build it
// whenever Metro starts, however it was started: `npx expo start ...` skips npm's prestart hook,
// and a stale engine is missing whatever the app now asks of it.
require('child_process').execFileSync(process.execPath, [path.join(projectRoot, 'scripts', 'build-score-engine.mjs')], { stdio: 'inherit' });

const config = getDefaultConfig(projectRoot);
config.watchFolders = [
  ...(config.watchFolders ?? []),
  path.join(repoRoot, 'audio'),
  path.join(repoRoot, 'practice'),
  path.join(repoRoot, 'score'),
  path.join(repoRoot, 'node_modules', 'pitchfinder'),
];
config.resolver.nodeModulesPaths = [path.join(projectRoot, 'node_modules'), path.join(repoRoot, 'node_modules')];

module.exports = config;
