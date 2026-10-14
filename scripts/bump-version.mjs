#!/usr/bin/env node
// `pnpm version:bump <patch|minor|major|x.y.z>` — bumps the iPhone AI version
// everywhere it lives, so every rebuilt "iPhone AI.app" is identifiable:
//   package.json (root + packages/*), src-tauri/tauri.conf.json,
//   src-tauri/Cargo.toml ([package] version) and packages/shared/src/version.ts.
// Rule (see CLAUDE.md): every edit or fix ships with a bump — patch for fixes,
// minor for new features or behaviour changes.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(root, p);

const JSON_FILES = ['package.json', 'packages/shared/package.json', 'packages/server/package.json', 'packages/web/package.json', 'src-tauri/tauri.conf.json'];
const VERSION_TS = 'packages/shared/src/version.ts';
const CARGO = 'src-tauri/Cargo.toml';

function current() {
  const match = /APP_VERSION = '(\d+\.\d+\.\d+)'/.exec(readFileSync(rel(VERSION_TS), 'utf8'));
  if (!match) throw new Error(`could not read APP_VERSION from ${VERSION_TS}`);
  return match[1];
}

function next(version, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  const [major, minor, patch] = version.split('.').map(Number);
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'major') return `${major + 1}.0.0`;
  throw new Error(`usage: pnpm version:bump <patch|minor|major|x.y.z> (got "${kind ?? ''}")`);
}

const kind = process.argv.slice(2).find((a) => a !== '--');
const from = current();
const to = next(from, kind);

for (const file of JSON_FILES) {
  const text = readFileSync(rel(file), 'utf8');
  const updated = text.replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${to}$2`);
  if (updated === text && !text.includes(`"version": "${to}"`)) throw new Error(`no version field updated in ${file}`);
  writeFileSync(rel(file), updated);
}
{
  const text = readFileSync(rel(CARGO), 'utf8');
  const updated = text.replace(/(\[package\][^[]*?\nversion\s*=\s*")\d+\.\d+\.\d+(")/, `$1${to}$2`);
  if (updated === text && from !== to) throw new Error(`no [package] version updated in ${CARGO}`);
  writeFileSync(rel(CARGO), updated);
}
writeFileSync(
  rel(VERSION_TS),
  readFileSync(rel(VERSION_TS), 'utf8').replace(/APP_VERSION = '\d+\.\d+\.\d+'/, `APP_VERSION = '${to}'`),
);
// Keep Cargo.lock's own entry in sync without a network round trip.
try {
  const lock = rel('src-tauri/Cargo.lock');
  const text = readFileSync(lock, 'utf8');
  writeFileSync(lock, text.replace(/(name = "iphone-ai"\nversion = ")\d+\.\d+\.\d+(")/, `$1${to}$2`));
} catch {
  // no lockfile yet
}
console.log(`iPhone AI version ${from} → ${to}`);
