// Lets the app import the web app's plain-TypeScript modules (pitch detection, grading, score
// following) from the repo root instead of copying them -- both apps share one implementation.
// Only those folders are watched: the repo also holds a Python virtualenv and test recordings.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..');

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
