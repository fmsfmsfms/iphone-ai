// Tiny RGBA PNG encoder (node:zlib deflate + CRC32) and the renderer that
// turns the simulated phone into screenshots. Output matches what Mirroir
// returns: the whole window at the backing scale (2x → 820x1796 for a
// 410x898 pt window), RGBA with transparent rounded corners. Rendering is
// deterministic for a given screen + state (the status-bar clock is drawn as a
// fixed block), so tests can compare frames for change detection.

import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** A raw RGBA canvas whose rows already carry the PNG filter byte (0 = None). */
export class Canvas {
  constructor(width, height, background) {
    this.width = width;
    this.height = height;
    this.stride = width * 4 + 1;
    this.raw = Buffer.alloc(this.stride * height);
    const row = Buffer.alloc(this.stride);
    row.fill(Buffer.from([...background, 255]), 1);
    row[0] = 0;
    for (let y = 0; y < height; y += 1) row.copy(this.raw, y * this.stride);
  }

  fillRect(x, y, w, h, color) {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    if (x1 <= x0 || y1 <= y0) return;
    const span = Buffer.alloc((x1 - x0) * 4);
    span.fill(Buffer.from([color[0], color[1], color[2], color[3] ?? 255]));
    for (let yy = y0; yy < y1; yy += 1) span.copy(this.raw, yy * this.stride + 1 + x0 * 4);
  }

  /** Mirroir's describe_screen grid: a 1 px white line (alpha 0.3) every `step` px. */
  grid(step) {
    const lighten = (i) => {
      for (let k = 0; k < 3; k += 1) this.raw[i + k] = this.raw[i + k] + (((255 - this.raw[i + k]) * 0.3) | 0);
    };
    for (let y = 0; y < this.height; y += 1) {
      const rowStart = y * this.stride + 1;
      if (y % step === 0) {
        for (let x = 0; x < this.width; x += 1) lighten(rowStart + x * 4);
      } else {
        for (let x = 0; x < this.width; x += step) lighten(rowStart + x * 4);
      }
    }
  }

  /** Transparent rounded window corners. */
  roundCorners(radius) {
    const r = Math.min(radius, Math.floor(this.width / 2), Math.floor(this.height / 2));
    for (let y = 0; y < r; y += 1) {
      for (let x = 0; x < r; x += 1) {
        const dx = r - x - 0.5;
        const dy = r - y - 0.5;
        if (dx * dx + dy * dy <= r * r) continue;
        for (const [px, py] of [
          [x, y],
          [this.width - 1 - x, y],
          [x, this.height - 1 - y],
          [this.width - 1 - x, this.height - 1 - y],
        ]) {
          this.raw[py * this.stride + 1 + px * 4 + 3] = 0;
        }
      }
    }
  }

  toPng() {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    return Buffer.concat([
      SIGNATURE,
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(this.raw, { level: 6 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

/** Deterministic, reasonably bright colour for a string (FNV-1a hash → HSV). */
export function colorFor(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hue = (h % 360) / 60;
  const c = 200;
  const x = Math.round(c * (1 - Math.abs((hue % 2) - 1)));
  const base = 40;
  const [r, g, b] =
    hue < 1 ? [c, x, 0] : hue < 2 ? [x, c, 0] : hue < 3 ? [0, c, x] : hue < 4 ? [0, x, c] : hue < 5 ? [x, 0, c] : [c, 0, x];
  return [r + base, g + base, b + base].map((v) => Math.min(255, v));
}

function darken(color, factor) {
  return color.map((v) => Math.round(v * factor));
}

/**
 * Renders a frame.
 * @param {object} opts
 * @param {number} opts.widthPt window width in points
 * @param {number} opts.heightPt window height in points
 * @param {number} opts.scale backing scale (pixels per point)
 * @param {number} opts.designW design-space width the elements are authored in
 * @param {number} opts.designH design-space height
 * @param {string} opts.sceneKey background seed (screen id)
 * @param {Array<object>} opts.elements visible elements in design coordinates
 * @param {string|null} opts.focusField focused text field id
 * @param {boolean} opts.grid draw the describe_screen grid overlay
 */
export function renderFrame(opts) {
  const { widthPt, heightPt, scale, designW, designH, sceneKey, elements, focusField, grid } = opts;
  const widthPx = Math.round(widthPt * scale);
  const heightPx = Math.round(heightPt * scale);
  const sx = (widthPt / designW) * scale;
  const sy = (heightPt / designH) * scale;
  const canvas = new Canvas(widthPx, heightPx, darken(colorFor(`bg:${sceneKey}`), 0.18));
  const rect = (cx, cy, w, h, color) => canvas.fillRect((cx - w / 2) * sx, (cy - h / 2) * sy, w * sx, h * sy, color);

  for (const e of elements) {
    if (e.statusBar) {
      // Fixed-size block so the minute-by-minute clock does not change frames.
      rect(e.x, e.y, 44, 16, [235, 235, 240]);
      continue;
    }
    if (e.field) {
      if (focusField === e.field) rect(e.x, e.y, 352, 44, [10, 132, 255]);
      rect(e.x, e.y, 344, 36, [44, 44, 46]);
    }
    if (e.kind === 'icon') {
      if (e.switchOn !== undefined) {
        rect(e.x, e.y, 50, e.size, e.switchOn ? [52, 199, 89] : [120, 120, 128]);
      } else {
        rect(e.x, e.y, e.size, e.size, colorFor(`icon:${e.name}`));
      }
      continue;
    }
    if (!e.label) continue;
    const len = [...e.label].length;
    if (e.appIcon) {
      rect(e.x, e.y, 58, 58, colorFor(`icon:${e.label}`));
      rect(e.x, e.y + 44, Math.min(90, len * 6), 12, [240, 240, 245]);
      continue;
    }
    if (e.card) {
      rect(e.x, e.y + 160, 170, 300, colorFor(`card:${e.label}`));
    }
    if (e.switchOn !== undefined) {
      rect(e.x + 10, e.y, 50, 30, e.switchOn ? [52, 199, 89] : [120, 120, 128]);
    }
    rect(e.x, e.y, Math.max(10, Math.min(380, len * 8.6)), 18, colorFor(`text:${e.label}`));
  }
  if (grid) canvas.grid(Math.max(1, Math.round(25 * scale)));
  canvas.roundCorners(Math.round(55 * scale));
  return { png: canvas.toPng(), widthPx, heightPx };
}
