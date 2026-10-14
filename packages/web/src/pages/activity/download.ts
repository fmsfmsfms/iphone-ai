// Saves a backend export (activity, diagnostics) as a file. The request goes
// through the API client first so errors surface as messages instead of a
// downloaded error page; the desktop shell saves blob downloads to ~/Downloads.

import { fetchBlob } from '../../lib/api';
import { filenameFromDisposition } from './helpers';

/** Downloads `url` (same-origin API path) and returns the file name it was saved as. */
export async function saveApiDownload(url: string, fallbackName: string): Promise<string> {
  const { blob, headers } = await fetchBlob(url);
  const name = filenameFromDisposition(headers.get('content-disposition'), fallbackName);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = name;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Give the browser (or the desktop shell) time to start reading the blob.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }
  return name;
}

/** "2026-10-14-153012" for fallback file names. */
export function fileStamp(at = new Date()): string {
  return at.toISOString().replace(/[:]/g, '').replace(/\..+$/, '').replace('T', '-');
}
