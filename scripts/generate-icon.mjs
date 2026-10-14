#!/usr/bin/env node
// Regenerates the app icon: renders src-tauri/app-icon.png (1024×1024) from
// assets/brand/logo.png with scripts/generate-icon.swift, then runs `tauri icon` to produce
// src-tauri/icons/* (icns, pngs) and drops the mobile / Windows Store variants
// this macOS-only app does not ship.
//
//   node scripts/generate-icon.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src-tauri', 'app-icon.png');
const logo = path.join(root, 'assets', 'brand', 'logo.png');
const iconsDir = path.join(root, 'src-tauri', 'icons');

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? result.signal}`);
  }
}

if (!existsSync('/usr/bin/swift')) {
  console.error('error: /usr/bin/swift not found — install the Xcode Command Line Tools (xcode-select --install).');
  process.exit(1);
}

try {
  run('/usr/bin/swift', [path.join(root, 'scripts', 'generate-icon.swift'), logo, source]);
  run('pnpm', ['tauri', 'icon', source]);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// Keep only what a macOS bundle (and the dev dock icon) uses.
const removed = [];
for (const entry of readdirSync(iconsDir)) {
  if (entry === 'android' || entry === 'ios' || /^Square\d+x\d+Logo\.png$/.test(entry) || entry === 'StoreLogo.png') {
    rmSync(path.join(iconsDir, entry), { recursive: true, force: true });
    removed.push(entry);
  }
}
if (removed.length > 0) console.log(`removed mobile/Windows Store icons: ${removed.join(', ')}`);
console.log(`icons ready in ${path.relative(root, iconsDir)}/`);
