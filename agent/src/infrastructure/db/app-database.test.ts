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

  // `CREATE TABLE IF NOT EXISTS` は既存のテーブルを作り直さない。テナント
  // 分離をやめた（→ D-35）あと、古い形のまま起動すると prepare が落ちて
  // Pod が上がらない。
  it('テナント時代のテーブルは作り直す（中身は捨てる。D-35）', () => {
    const old = new DatabaseSync(path);
    old.exec(
      `CREATE TABLE reminders (
         id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL,
         description TEXT, due_at TEXT NOT NULL, recurrence TEXT,
         channel_id TEXT NOT NULL, guild_id TEXT, created_by TEXT,
         created_at TEXT NOT NULL, fired_at TEXT
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
      .all() as unknown as { name: string }[];
    const names = columns.map((column) => column.name);
    expect(names).not.toContain('tenant_id');
    expect(names).toContain('recurrence');

    // 作り直しなので行は残らない。**気付けるように WARN が出る**（INV-7）。
    expect(db.prepare('SELECT id FROM reminders').all()).toHaveLength(0);
    db.close();
  });

  it('二度開いても壊れない（作り直しは一度だけ）', () => {
    openAppDatabase(path).close();
    expect(() => openAppDatabase(path).close()).not.toThrow();
  });

  it('話者プロフィールのテーブルが用意される（F-05）', () => {
    const db = openAppDatabase(path);
    db.exec(
      `INSERT INTO person_profiles (speaker_id, display_name, first_seen_at)
       VALUES ('discord-user-1', 'ゆい', '2026-09-20T00:00:00.000Z')`,
    );
    expect(
      db.prepare('SELECT display_name FROM person_profiles').all(),
    ).toEqual([{ display_name: 'ゆい' }]);
    db.close();
  });

  // メモは相手の行にぶら下がる。誰のものか決まらないメモを残さない。
  it('プロフィールのない話者のメモは入らない', () => {
    const db = openAppDatabase(path);
    expect(() =>
      db.exec(
        `INSERT INTO person_notes (id, speaker_id, content, recorded_at)
         VALUES ('n1', 'discord-user-404', 'x', '2026-09-20T00:00:00.000Z')`,
      ),
    ).toThrow();
    db.close();
  });

  it('途中のディレクトリを作る', () => {
    const nested = join(directory, 'nested', 'yachi.db');
    expect(() => openAppDatabase(nested).close()).not.toThrow();
  });
});
