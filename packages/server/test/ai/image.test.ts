// downscaleForModel: screenshots for the model are resized with macOS sips and
// re-encoded as JPEG; any failure falls back to the original PNG.

import { readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { downscaleForModel, jpegDimensions } from '../../src/ai/image.js';
import { makeTempDir } from '../helpers/context.js';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** An RGBA PNG: light background with a blue block (like a UI screenshot). */
function png(width: number, height: number): string {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height, 240);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const o = y * stride + 1 + x * 4;
      if (x > 20 && x < width / 2 && y > 20 && y < height / 3) raw.set([30, 120, 220], o);
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const tempEntries = () => readdirSync(tmpdir()).filter((n) => n.startsWith('iphone-ai-img-')).length;

describe.runIf(process.platform === 'darwin')('downscaleForModel (macOS sips)', () => {
  it('resizes a full-size screenshot to at most 1400 px and re-encodes it as JPEG', async () => {
    const before = tempEntries();
    const out = await downscaleForModel(png(820, 1796));
    expect(out.mimeType).toBe('image/jpeg');
    expect(Math.max(out.width!, out.height!)).toBe(1400);
    expect(out.width).toBeGreaterThan(600);
    expect(jpegDimensions(Buffer.from(out.data, 'base64'))).toEqual({ width: out.width, height: out.height });
    // Temporary files are removed.
    expect(tempEntries()).toBe(before);
  });

  it('never enlarges a small image', async () => {
    const out = await downscaleForModel(png(300, 600));
    expect(out).toMatchObject({ mimeType: 'image/jpeg', width: 300, height: 600 });
  });
});

describe('downscaleForModel fallbacks', () => {
  it('returns the original PNG when sips fails or is missing', async () => {
    const original = png(820, 1796);
    const dir = makeTempDir();
    const failing = path.join(dir, 'sips');
    writeFileSync(failing, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    for (const sipsPath of [failing, path.join(dir, 'missing')]) {
      const out = await downscaleForModel(original, { sipsPath });
      expect(out).toEqual({ data: original, mimeType: 'image/png', width: 820, height: 1796 });
    }
  });

  it('returns non-PNG input unchanged', async () => {
    const out = await downscaleForModel('bm90IGEgcG5n');
    expect(out).toMatchObject({ data: 'bm90IGEgcG5n', mimeType: 'image/png' });
  });
});
