#!/usr/bin/env node
// Builds iPhone AI's input helper (src-tauri/input/main.swift: the "glide" swipe) into
// src-tauri/binaries/iphone-ai-input-<rust target triple>, the name Tauri expects for the
// `binaries/iphone-ai-input` externalBin (bundled as Contents/MacOS/iphone-ai-input and
// re-signed there with the app identity). Same steps as scripts/build-capture.mjs: embedded
// Info.plist (LSBackgroundOnly), ad-hoc signature for runs from the repo, --help smoke test.
//
//   node scripts/build-input.mjs [--force] [--target aarch64-apple-darwin|x86_64-apple-darwin]
//
// Run automatically by `pnpm package:mac` (also with --stage-only).

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildSwiftHelper, helperBinaryPath, hostTriple, smokeTestHelper } from './build-capture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INPUT_NAME = 'iphone-ai-input';

const INPUT_SPEC = {
  name: INPUT_NAME,
  source: path.join(root, 'src-tauri', 'input', 'main.swift'),
  infoPlist: path.join(root, 'src-tauri', 'input', 'Info.plist'),
  signingIdentifier: 'me.alsaud.iphoneai.input',
  frameworks: ['AppKit', 'ApplicationServices', 'CoreGraphics'],
  parseAsLibrary: false,
};

export function inputBinaryPath(triple = hostTriple()) {
  return helperBinaryPath(INPUT_NAME, triple);
}

/** Compiles, ad-hoc signs and smoke-tests the input helper (see buildSwiftHelper). */
export function buildInput(options = {}) {
  return buildSwiftHelper(INPUT_SPEC, options);
}

/** `--help` and the embedded LSBackgroundOnly Info.plist. */
export function smokeTestInput(binary) {
  return smokeTestHelper(binary, INPUT_NAME);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const argv = process.argv.slice(2).filter((arg) => arg !== '--');
    const targetIndex = argv.indexOf('--target');
    const target = targetIndex >= 0 ? argv[targetIndex + 1] : argv.find((arg) => arg.startsWith('--target='))?.slice(9);
    buildInput({ force: argv.includes('--force'), target: target ?? hostTriple() });
  } catch (error) {
    console.error(`build-input failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
