'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_VAULT_PLUGINS_DIR = process.platform === 'win32'
  ? 'D:\\plugin-testing-vault\\.obsidian\\plugins'
  : '/mnt/d/plugin-testing-vault/.obsidian/plugins';

const repoRoot = path.resolve(__dirname, '..');
const vaultPluginsDir =
  process.env.OBSIDIAN_VAULT_PLUGINS_DIR ||
  process.env.OBSIDIAN_PLUGINS_DIR ||
  DEFAULT_VAULT_PLUGINS_DIR;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function findArtifactDir() {
  const candidates = [path.join(repoRoot, 'build'), repoRoot];

  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, 'main.js')) &&
      fs.existsSync(path.join(dir, 'manifest.json'))
    ) {
      return dir;
    }
  }

  throw new Error(
    'Could not find build artifacts. Expected main.js and manifest.json in ./build or the repo root. Run the build first.',
  );
}

function main() {
  const manifestPath = path.join(repoRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json not found: ${manifestPath}`);
  }

  const manifest = readJson(manifestPath);
  const pluginId = manifest.id;
  if (typeof pluginId !== 'string' || pluginId.trim() === '') {
    throw new Error('manifest.json is missing a valid "id" field');
  }

  const artifactDir = findArtifactDir();
  const destDir = path.join(vaultPluginsDir, pluginId);
  fs.mkdirSync(destDir, { recursive: true });

  for (const filename of ['main.js', 'manifest.json', 'styles.css']) {
    const source = path.join(artifactDir, filename);
    if (!fs.existsSync(source)) {
      if (filename === 'styles.css') continue;
      throw new Error(`Required build artifact not found: ${source}`);
    }

    const dest = path.join(destDir, filename);
    fs.copyFileSync(source, dest);
    console.log(`Copied ${source} -> ${dest}`);
  }

  console.log(`Copied plugin "${pluginId}" to ${destDir}`);
}

main();
