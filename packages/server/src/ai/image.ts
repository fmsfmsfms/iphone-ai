// Screenshots sent to AI models are downscaled and re-encoded as JPEG.
//
// Mirroir returns full-resolution PNGs (820×1796 for a 410×898 pt window,
// often 0.2–3 MB of base64). Every observation's image stays in the model's
// history, so the request grows with each action. Claude downsizes anything
// over ~1568 px on its side anyway; a ≤1400 px JPEG keeps the 25-point grid
// readable at a fraction of the bytes. The stored step screenshot is NOT
// changed — only the copy that goes to the model.
//
// Uses macOS's built-in /usr/bin/sips (no dependency). Any failure returns the
// original PNG unchanged.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { base64PngDimensions } from '../device/png.js';

export interface ModelImage {
  data: string;
  mimeType: string;
  width: number | null;
  height: number | null;
}

export interface DownscaleOptions {
  /** Longest edge in pixels (default 1400). */
  maxEdge?: number;
  /** JPEG quality 1–100 (default 75). */
  quality?: number;
  /** Path of sips (tests). */
  sipsPath?: string;
  timeoutMs?: number;
}

const SIPS = '/usr/bin/sips';

export async function downscaleForModel(base64Png: string, opts: DownscaleOptions = {}): Promise<ModelImage> {
  const dims = base64PngDimensions(base64Png);
  const original: ModelImage = { data: base64Png, mimeType: 'image/png', width: dims?.width ?? null, height: dims?.height ?? null };
  const sips = opts.sipsPath ?? SIPS;
  if (process.platform !== 'darwin' || !existsSync(sips) || !dims) return original;
  const maxEdge = Math.max(64, Math.round(opts.maxEdge ?? 1400));
  const quality = Math.min(100, Math.max(1, Math.round(opts.quality ?? 75)));

  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'iphone-ai-img-'));
    const input = path.join(dir, 'in.png');
    const output = path.join(dir, 'out.jpg');
    await writeFile(input, Buffer.from(base64Png, 'base64'), { mode: 0o600 });
    // -Z also enlarges smaller images, so it is only passed when shrinking.
    const resize = Math.max(dims.width, dims.height) > maxEdge ? ['-Z', String(maxEdge)] : [];
    await run(sips, ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), ...resize, input, '--out', output], opts.timeoutMs ?? 15000);
    const jpeg = await readFile(output);
    const size = jpegDimensions(jpeg);
    if (!size || jpeg.length === 0) return original;
    return { data: jpeg.toString('base64'), mimeType: 'image/jpeg', width: size.width, height: size.height };
  } catch {
    return original;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function run(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, env: { PATH: '/usr/bin:/bin' } }, (err) => (err ? reject(err) : resolve()));
  });
}

/** Width/height from a JPEG's SOFn header. */
export function jpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return null;
}
