// node:sqlite persistence: migrations, pragmas, helpers.

import { existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database, fromJson, toJson } from '../../src/db/database.js';
import { makeTempDir } from '../helpers/context.js';

const TABLES = [
  'activity',
  'approvals',
  'chat_messages',
  'conversations',
  'remote_sessions',
  'schema_migrations',
  'screenshots',
  'settings',
  'task_steps',
  'tasks',
  'workflow_runs',
  'workflows',
];

let dir: string;
let file: string;

beforeEach(() => {
  dir = makeTempDir();
  file = path.join(dir, 'test.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tables(db: Database): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((r) => r.name);
}

describe('Database', () => {
  it('creates the schema and records the migration', () => {
    const db = new Database(file);
    try {
      expect(tables(db)).toEqual(TABLES);
      expect(db.all('SELECT version FROM schema_migrations')).toEqual([{ version: 1 }]);
    } finally {
      db.close();
    }
  });

  it('runs migrations idempotently when reopened', () => {
    const first = new Database(file);
    first.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', 'k', 'v', 1);
    first.close();
    for (let i = 0; i < 3; i += 1) {
      const db = new Database(file);
      try {
        expect(db.all('SELECT version FROM schema_migrations')).toEqual([{ version: 1 }]);
        expect(tables(db)).toEqual(TABLES);
        expect(db.get('SELECT value FROM settings WHERE key = ?', 'k')).toEqual({ value: 'v' });
      } finally {
        db.close();
      }
    }
  });

  it('uses WAL, foreign keys and owner-only file permissions', () => {
    const db = new Database(file);
    try {
      expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
      expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      db.close();
    }
    expect(existsSync(file)).toBe(true);
  });

  it('cascades deletes through foreign keys', () => {
    const db = new Database(':memory:');
    try {
      db.run('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', 'c1', 'Chat', 1, 1);
      db.run('INSERT INTO chat_messages (id, conversation_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)', 'm1', 'c1', 'user', 'hi', 1);
      expect(() =>
        db.run('INSERT INTO chat_messages (id, conversation_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)', 'm2', 'nope', 'user', 'x', 1),
      ).toThrow();
      expect(db.run('DELETE FROM conversations WHERE id = ?', 'c1').changes).toBe(1);
      expect(db.all('SELECT * FROM chat_messages')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('commits and rolls back transactions', () => {
    const db = new Database(':memory:');
    try {
      const value = db.transaction(() => {
        db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', 'a', '1', 1);
        return 'done';
      });
      expect(value).toBe('done');
      expect(() =>
        db.transaction(() => {
          db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', 'b', '2', 1);
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(db.all<{ key: string }>('SELECT key FROM settings').map((r) => r.key)).toEqual(['a']);
    } finally {
      db.close();
    }
  });

  it('reports changed rows and returns undefined for missing rows', () => {
    const db = new Database(':memory:');
    try {
      expect(db.run('UPDATE settings SET value = ? WHERE key = ?', 'x', 'missing').changes).toBe(0);
      expect(db.get('SELECT * FROM settings WHERE key = ?', 'missing')).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe('JSON helpers', () => {
  it('round-trips values and falls back on bad input', () => {
    expect(toJson({ a: [1, 'b'] })).toBe('{"a":[1,"b"]}');
    expect(toJson(undefined)).toBe('null');
    expect(fromJson<{ a: number }>('{"a":1}', { a: 0 })).toEqual({ a: 1 });
    expect(fromJson('{oops', 'fallback')).toBe('fallback');
    expect(fromJson(null, [])).toEqual([]);
    expect(fromJson(42, 'n')).toBe('n');
  });
});
