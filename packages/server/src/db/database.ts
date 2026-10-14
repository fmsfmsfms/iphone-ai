// SQLite persistence using Node's built-in `node:sqlite` (no native addon to
// rebuild or sign). WAL mode, foreign keys on, forward-only migrations.

import { chmodSync, existsSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type SqlParam = SQLInputValue;
export type Row = Record<string, SqlParam>;

const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        task_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_chat_messages_conv ON chat_messages(conversation_id, created_at);

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        instruction TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        provider_label TEXT NOT NULL,
        model TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        actions_used INTEGER NOT NULL DEFAULT 0,
        max_actions INTEGER NOT NULL,
        current_activity TEXT,
        outcome_json TEXT,
        error TEXT
      );
      CREATE INDEX idx_tasks_conv ON tasks(conversation_id, created_at);

      CREATE TABLE task_steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        tool_json TEXT,
        screenshot_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_task_steps_task ON task_steps(task_id, idx);

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        actor TEXT NOT NULL,
        task_id TEXT,
        workflow_run_id TEXT,
        summary TEXT NOT NULL,
        action_json TEXT NOT NULL,
        risk TEXT NOT NULL,
        reasons_json TEXT NOT NULL,
        frame_seq INTEGER,
        decided_at INTEGER,
        decided_by TEXT,
        note TEXT
      );
      CREATE INDEX idx_approvals_created ON approvals(created_at);

      CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_run_at INTEGER,
        last_run_status TEXT,
        last_success_at INTEGER
      );

      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        current_step_index INTEGER NOT NULL,
        steps_json TEXT NOT NULL,
        error TEXT,
        retry_of TEXT
      );
      CREATE INDEX idx_workflow_runs_wf ON workflow_runs(workflow_id, started_at);

      CREATE TABLE activity (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        category TEXT NOT NULL,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        severity TEXT NOT NULL,
        summary TEXT NOT NULL,
        tool TEXT,
        success INTEGER,
        duration_ms INTEGER,
        task_id TEXT,
        workflow_run_id TEXT,
        detail_json TEXT
      );
      CREATE INDEX idx_activity_at ON activity(at);
      CREATE INDEX idx_activity_category ON activity(category, at);
      CREATE INDEX idx_activity_task ON activity(task_id);

      CREATE TABLE remote_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        device_name TEXT,
        ip TEXT,
        user_agent TEXT,
        can_control INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );

      CREATE TABLE screenshots (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        task_id TEXT,
        workflow_run_id TEXT
      );
      CREATE INDEX idx_screenshots_created ON screenshots(created_at);
    `,
  },
];

export class Database {
  readonly raw: DatabaseSync;

  constructor(file: string) {
    const isNew = file !== ':memory:' && !existsSync(file);
    this.raw = new DatabaseSync(file);
    if (isNew) {
      try {
        chmodSync(file, 0o600);
      } catch {
        // best effort
      }
    }
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);',
    );
    const applied = new Set(
      (this.raw.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.raw.exec(migration.sql);
        this.raw
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, Date.now());
      });
    }
  }

  all<T = Row>(sql: string, ...params: SqlParam[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T = Row>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SqlParam[]): { changes: number } {
    const result = this.raw.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }
}

/** JSON helpers for TEXT columns. */
export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
