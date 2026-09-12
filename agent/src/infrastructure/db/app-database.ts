import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { logger } from '../../observability/logger.ts';

/**
 * ランタイム状態（リマインダー・スキル・人格差分）の SQLite（→ D-24）。
 *
 * **Flue の会話履歴 DB とは別ファイルにする。** 会話履歴は Flue ランタイムが
 * スキーマごと所有していて、自動圧縮も含めて書き手が向こう側にある（永続化
 * 一覧の #1「独自に触らない」）。同じファイルへ相乗りすると、向こうの
 * マイグレーションと衝突したときに会話履歴まで一緒に失う。
 *
 * ドライバは Flue と同じ `node:sqlite` の `DatabaseSync`。同期なのは都合では
 * なく要件で、人格差分とスキルはエージェントの render から同期で読む。
 */

/**
 * 静的設定（設定ファイル）はここに入らない。人が書くものとプロセスが積み上げる
 * ものを同じ実体に置かない（INV-8）。
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reminders (
     id           TEXT PRIMARY KEY,
     tenant_id    TEXT NOT NULL,
     title        TEXT NOT NULL,
     description  TEXT,
     due_at       TEXT NOT NULL,
     channel_id   TEXT NOT NULL,
     guild_id     TEXT,
     created_by   TEXT,
     created_at   TEXT NOT NULL,
     fired_at     TEXT
   )`,
  // poller は「未発火かつ期限到来」を引く。テナント列を含めるのは一覧用。
  `CREATE INDEX IF NOT EXISTS reminders_due
     ON reminders (fired_at, due_at)`,
  `CREATE INDEX IF NOT EXISTS reminders_tenant_due
     ON reminders (tenant_id, fired_at, due_at)`,

  `CREATE TABLE IF NOT EXISTS persona_diffs (
     id           TEXT PRIMARY KEY,
     tenant_id    TEXT NOT NULL,
     instruction  TEXT NOT NULL,
     reason       TEXT NOT NULL,
     recorded_at  TEXT NOT NULL,
     reverted_at  TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS persona_diffs_tenant
     ON persona_diffs (tenant_id, reverted_at, recorded_at)`,

  // name は Flue のスキル名でもあるので、テナント内で一意にする。却下した
  // 候補も行として残す —— 消すとキュレーターが同じ名前を出し直す。
  `CREATE TABLE IF NOT EXISTS skills (
     id           TEXT PRIMARY KEY,
     tenant_id    TEXT NOT NULL,
     name         TEXT NOT NULL,
     description  TEXT NOT NULL,
     instructions TEXT NOT NULL,
     kind         TEXT NOT NULL,
     status       TEXT NOT NULL,
     proposed_at  TEXT NOT NULL,
     decided_at   TEXT,
     UNIQUE (tenant_id, name)
   )`,
  `CREATE INDEX IF NOT EXISTS skills_tenant_status
     ON skills (tenant_id, status, proposed_at)`,
];

/**
 * DB を開いてスキーマを用意する。**失敗したら投げる** —— 書けない状態で
 * 起動すると、リマインダーを受け付けたつもりで消えていく。
 */
export function openAppDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);
  // WAL は読み書きの衝突を減らす。プロセスは 1 本（レプリカ 1）なので
  // ロック競合は本来起きないが、poller とツールが同じ行を触る
  // （→ 04-architecture.md の「共有される書き込み先の棚卸し」）。
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  for (const statement of SCHEMA) db.exec(statement);

  logger.info({ path }, 'Opened the runtime state database');
  return db;
}
