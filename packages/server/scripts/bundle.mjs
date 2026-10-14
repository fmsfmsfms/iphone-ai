#!/usr/bin/env node
// Bundles the backend into one ESM file for the desktop app:
//   packages/server/src/main.ts -> packages/server/dist/server.mjs (+ .map)
//
//   node packages/server/scripts/bundle.mjs [entry.ts] [--out <file.mjs>]
//
// Every dependency is inlined (the app ships no node_modules). The banner
// defines `require` because CJS dependencies (cross-spawn in the MCP SDK)
// call require('child_process') at runtime, which a plain ESM bundle cannot do.
// The Claude Agent SDK cannot find its native binary from inside a bundle; the
// desktop app passes it explicitly via IPHONE_AI_CLAUDE_CODE_BIN.

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverDir, '..', '..');

function parseArgs(argv) {
  const options = { entry: path.join(serverDir, 'src', 'main.ts'), outfile: path.join(serverDir, 'dist', 'server.mjs') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error('--out needs a file path');
      options.outfile = path.resolve(value);
      i += 1;
    } else if (arg === '-h' || arg === '--help') {
      console.log('usage: node packages/server/scripts/bundle.mjs [entry.ts] [--out <file.mjs>]');
      process.exit(0);
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      options.entry = path.resolve(arg);
    }
  }
  return options;
}

function display(file) {
  const relative = path.relative(repoRoot, file);
  return relative.startsWith('..') ? file : relative;
}

function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

async function main() {
  const { entry, outfile } = parseArgs(process.argv.slice(2));
  if (!existsSync(entry)) {
    throw new Error(`entry not found: ${entry}`);
  }

  const started = Date.now();
  const result = await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    minify: false,
    sourcemap: 'linked',
    // Resolve packages for entries outside packages/server too (e.g. a scratch test entry).
    nodePaths: [path.join(serverDir, 'node_modules'), path.join(repoRoot, 'node_modules')],
    tsconfig: path.join(serverDir, 'tsconfig.json'),
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    define: { 'process.env.NODE_ENV': '"production"' },
    metafile: true,
    logLevel: 'warning',
  });

  const size = statSync(outfile).size;
  const mapFile = `${outfile}.map`;
  const mapSize = existsSync(mapFile) ? statSync(mapFile).size : 0;
  const inputs = Object.keys(result.metafile.inputs).length;
  console.log(
    `bundled ${display(entry)} -> ${display(outfile)}: ${formatBytes(size)}` +
      `${mapSize ? ` (+ ${formatBytes(mapSize)} source map)` : ''}, ${inputs} modules, ` +
      `${result.warnings.length} warning(s), ${Date.now() - started} ms`,
  );
}

main().catch((error) => {
  console.error(`bundle failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
