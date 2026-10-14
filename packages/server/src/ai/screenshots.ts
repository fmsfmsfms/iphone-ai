// Screenshots attached to AI steps and workflow runs.
//
// Kept in memory (bounded LRU) for the running session so the UI can show
// them. Written to disk only when the user opted in (privacy.storeScreenshots),
// and pruned after the retention period.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Database } from '../db/database.js';
import { newId } from '../core/ids.js';
import type { AppPaths } from '../core/paths.js';
import type { SettingsStore } from '../core/settings-store.js';

interface Entry {
  data: Buffer;
  mimeType: string;
  createdAt: number;
}

const MAX_ENTRIES = 200;
const MAX_BYTES = 200 * 1024 * 1024;

export class ScreenshotStore {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  constructor(
    private readonly db: Database,
    private readonly paths: AppPaths,
    private readonly settings: SettingsStore,
  ) {}

  put(base64OrBuffer: string | Buffer, mimeType: string, links: { taskId?: string | null; workflowRunId?: string | null } = {}): string {
    const data = typeof base64OrBuffer === 'string' ? Buffer.from(base64OrBuffer, 'base64') : base64OrBuffer;
    const id = newId('shot');
    this.entries.set(id, { data, mimeType, createdAt: Date.now() });
    this.bytes += data.length;
    this.evict();
    if (this.settings.get().privacy.storeScreenshots) {
      const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const file = path.join(this.paths.screenshotsDir, `${id}.${ext}`);
      try {
        writeFileSync(file, data, { mode: 0o600 });
        this.db.run(
          'INSERT INTO screenshots (id, created_at, path, mime_type, width, height, task_id, workflow_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          id,
          Date.now(),
          file,
          mimeType,
          null,
          null,
          links.taskId ?? null,
          links.workflowRunId ?? null,
        );
      } catch {
        // Persisting is best effort; the in-memory copy still serves the UI.
      }
    }
    return id;
  }

  get(id: string): { data: Buffer; mimeType: string } | null {
    const entry = this.entries.get(id);
    if (entry) return { data: entry.data, mimeType: entry.mimeType };
    if (!/^shot_[a-z0-9]+$/.test(id)) return null;
    const row = this.db.get<{ path: string; mime_type: string }>('SELECT path, mime_type FROM screenshots WHERE id = ?', id);
    if (!row || !existsSync(row.path)) return null;
    try {
      return { data: readFileSync(row.path), mimeType: row.mime_type };
    } catch {
      return null;
    }
  }

  /** Deletes persisted screenshots older than the retention window (or all). */
  prune(all = false): number {
    const days = this.settings.get().privacy.screenshotRetentionDays;
    const cutoff = all ? Number.MAX_SAFE_INTEGER : Date.now() - days * 86_400_000;
    const rows = this.db.all<{ id: string; path: string }>('SELECT id, path FROM screenshots WHERE created_at < ?', cutoff);
    for (const row of rows) {
      try {
        unlinkSync(row.path);
      } catch {
        // already gone
      }
      this.db.run('DELETE FROM screenshots WHERE id = ?', row.id);
    }
    if (all) {
      this.entries.clear();
      this.bytes = 0;
    }
    return rows.length;
  }

  private evict(): void {
    while (this.entries.size > MAX_ENTRIES || this.bytes > MAX_BYTES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const entry = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (entry) this.bytes -= entry.data.length;
    }
  }
}
