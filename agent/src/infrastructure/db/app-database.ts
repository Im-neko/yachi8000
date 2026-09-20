import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { logger } from '../../observability/logger.ts';

/**
 * ランタイム状態（リマインダー・スキル・人格差分・話者プロフィール）の
 * SQLite（→ D-24）。
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
     title        TEXT NOT NULL,
     description  TEXT,
     due_at       TEXT NOT NULL,
     recurrence   TEXT,
     channel_id   TEXT NOT NULL,
     guild_id     TEXT,
     created_by   TEXT,
     created_at   TEXT NOT NULL,
     fired_at     TEXT
   )`,
  // poller は「未発火かつ期限到来」を引く。登録者列を含めるのは一覧用
  // （一覧と取り消しは自分の分だけを見せる → D-35）。
  `CREATE INDEX IF NOT EXISTS reminders_due
     ON reminders (fired_at, due_at)`,
  `CREATE INDEX IF NOT EXISTS reminders_creator_due
     ON reminders (created_by, fired_at, due_at)`,

  `CREATE TABLE IF NOT EXISTS persona_diffs (
     id           TEXT PRIMARY KEY,
     instruction  TEXT NOT NULL,
     reason       TEXT NOT NULL,
     recorded_at  TEXT NOT NULL,
     reverted_at  TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS persona_diffs_active
     ON persona_diffs (reverted_at, recorded_at)`,

  // name は Flue のスキル名でもあるので一意にする。却下した候補も行として
  // 残す —— 消すとキュレーターが同じ名前を出し直す。
  `CREATE TABLE IF NOT EXISTS skills (
     id           TEXT PRIMARY KEY,
     name         TEXT NOT NULL UNIQUE,
     description  TEXT NOT NULL,
     instructions TEXT NOT NULL,
     kind         TEXT NOT NULL,
     status       TEXT NOT NULL,
     proposed_at  TEXT NOT NULL,
     decided_at   TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS skills_status
     ON skills (status, proposed_at)`,

  // 話しかけてくる相手（F-05）。鍵は正規化済みの話者 ID。
  `CREATE TABLE IF NOT EXISTS person_profiles (
     speaker_id    TEXT PRIMARY KEY,
     display_name  TEXT NOT NULL,
     first_seen_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS person_notes (
     id          TEXT PRIMARY KEY,
     speaker_id  TEXT NOT NULL
                 REFERENCES person_profiles (speaker_id) ON DELETE CASCADE,
     content     TEXT NOT NULL,
     recorded_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS person_notes_speaker
     ON person_notes (speaker_id, recorded_at)`,
];

/**
 * **テナント分離をやめたときに落としたテーブル**（→ D-35）。
 *
 * `tenant_id` は `skills` の UNIQUE 制約に入っていて、SQLite は制約に
 * 含まれる列を `DROP COLUMN` できない。リリース前なので中身は捨てる
 * （オーナー判断）。**互換のための移行コードは残さない。**
 *
 * 判定に `tenant_id` 列の有無を使う。列が無ければ作り直し済み。
 */
const TENANT_SCOPED_TABLES = ['reminders', 'persona_diffs', 'skills'] as const;

/**
 * **`CREATE TABLE IF NOT EXISTS` は既存のテーブルを作り直さないし、列も
 * 足さない。** 既に DB があるところへスキーマだけ書き換えると、`prepare` が
 * 起動時に落ちて Pod が上がらない。形を変えるときは、この関数のように
 * `PRAGMA table_info` で今の形を見てから手を入れること。

 */
function dropTenantScopedTables(db: DatabaseSync): void {
  for (const table of TENANT_SCOPED_TABLES) {
    const columns = db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as unknown as { name: string }[];
    if (columns.length === 0) continue;
    if (!columns.some((column) => column.name === 'tenant_id')) continue;
    db.exec(`DROP TABLE ${table}`);
    logger.warn(
      { table },
      'Dropped a tenant-scoped table — its rows are gone (D-35)',
    );
  }
}

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
  dropTenantScopedTables(db);
  for (const statement of SCHEMA) db.exec(statement);

  logger.info({ path }, 'Opened the runtime state database');
  return db;
}
