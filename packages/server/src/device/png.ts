// Minimal PNG header reader (no image dependencies).

export function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  // 8-byte signature, then IHDR: length(4) "IHDR"(4) width(4) height(4)
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function base64PngDimensions(base64: string): { width: number; height: number } | null {
  // The first 32 base64 chars decode to 24 bytes — enough for the IHDR fields.
  try {
    return pngDimensions(Buffer.from(base64.slice(0, 44), 'base64'));
  } catch {
    return null;
  }
}
