import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAppDatabase } from './app-database.ts';

describe('openAppDatabase', () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'yachi-db-'));
    path = join(directory, 'yachi.db');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('無い列を後から足す（CREATE TABLE IF NOT EXISTS は足さない）', () => {
    // 列が増える前の DB を作る。ここで足りない列のまま起動すると、
    // prepare が落ちて Pod が上がらない。
    const old = new DatabaseSync(path);
    old.exec(
      `CREATE TABLE reminders (
         id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL,
         description TEXT, due_at TEXT NOT NULL, channel_id TEXT NOT NULL,
         guild_id TEXT, created_by TEXT, created_at TEXT NOT NULL, fired_at TEXT
       )`,
    );
    old.exec(
      `INSERT INTO reminders (id, tenant_id, title, due_at, channel_id, created_at)
       VALUES ('r1', 't1', 'ゴミを出す', '2026-09-15T00:00:00.000Z', 'c1', '2026-09-12T00:00:00.000Z')`,
    );
    old.close();

    const db = openAppDatabase(path);
    const columns = db
      .prepare('PRAGMA table_info(reminders)')
      .all() as unknown as {
      name: string;
    }[];
    expect(columns.map((column) => column.name)).toContain('recurrence');

    // 既存の行は残り、繰り返しなしとして読める。
    const rows = db
      .prepare('SELECT id, recurrence FROM reminders')
      .all() as unknown as { id: string; recurrence: string | null }[];
    expect(rows).toEqual([{ id: 'r1', recurrence: null }]);
    db.close();
  });

  it('二度開いても壊れない（列を足す手順は冪等）', () => {
    openAppDatabase(path).close();
    expect(() => openAppDatabase(path).close()).not.toThrow();
  });

  it('途中のディレクトリを作る', () => {
    const nested = join(directory, 'nested', 'yachi.db');
    expect(() => openAppDatabase(nested).close()).not.toThrow();
  });
});
