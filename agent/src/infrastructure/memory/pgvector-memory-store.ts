import { Pool } from 'pg';
import type { MemoryRecord, MemorySearchHit } from '../../domain/memory.ts';
import type { Embedder } from '../../domain/ports/embedder.ts';
import type {
  MemoryStore,
  RecallInput,
  RememberInput,
} from '../../domain/ports/memory-store.ts';
import type { SpeakerId } from '../../domain/speaker.ts';
import { logger } from '../../observability/logger.ts';

const TABLE = 'long_term_memories';

interface MemoryRow {
  id: string;
  speaker_id: string | null;
  content: string;
  recorded_at: Date;
}

function toRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    speakerId: (row.speaker_id ?? undefined) as SpeakerId | undefined,
    content: row.content,
    recordedAt: row.recorded_at.toISOString(),
  };
}

/** pgvector のリテラル表現。`pg` は vector 型を知らないので文字列で渡して明示的にキャストする。 */
function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

export interface CreatePgvectorMemoryStoreInput {
  connectionString: string;
  embedder: Embedder;
}

export interface PgvectorMemoryStore extends MemoryStore {
  /** 起動時に 1 度呼ぶ。拡張・テーブル・インデックスを用意し、次元数の食い違いを検出する。 */
  ensureSchema(): Promise<void>;
  close(): Promise<void>;
}

export function createPgvectorMemoryStore(
  input: CreatePgvectorMemoryStoreInput,
): PgvectorMemoryStore {
  const pool = new Pool({ connectionString: input.connectionString });
  const { embedder } = input;

  return {
    async ensureSchema() {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          speaker_id text,
          content text NOT NULL,
          embedding vector(${embedder.dimensions}) NOT NULL,
          recorded_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      // テナント分離をやめたので、その列と索引を落とす（→ D-35）。記憶の
      // 中身は消さない —— フェーズ 1 から積んだ行はそのまま残す。
      await pool.query(`DROP INDEX IF EXISTS ${TABLE}_tenant_recorded_idx`);
      await pool.query(`ALTER TABLE ${TABLE} DROP COLUMN IF EXISTS tenant_id`);
      // **テナント時代の `speaker_id` は Discord の生のスノーフレーク。**
      // 今は入口で正規化した `discord-user-<id>` を入れる（F-05）ので、
      // 直さないと同じ人が 2 つの ID を持ち、話者で絞った想起が古い記憶を
      // 取りこぼす。正規表現は接頭辞が付いた後には当たらないので冪等。
      const migrated = await pool.query(
        `UPDATE ${TABLE}
            SET speaker_id = 'discord-user-' || speaker_id
          WHERE speaker_id ~ '^[0-9]+$'`,
      );
      if ((migrated.rowCount ?? 0) > 0) {
        logger.warn(
          { table: TABLE, rows: migrated.rowCount },
          'Namespaced legacy speaker ids on long-term memories (D-35)',
        );
      }
      // 一覧は新しい順に引く。
      await pool.query(`
        CREATE INDEX IF NOT EXISTS ${TABLE}_recorded_idx
          ON ${TABLE} (recorded_at DESC)
      `);
      // 「この人が言ったこと」に絞る想起のため（F-05）。既定は全体から引く。
      await pool.query(`
        CREATE INDEX IF NOT EXISTS ${TABLE}_speaker_recorded_idx
          ON ${TABLE} (speaker_id, recorded_at DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS ${TABLE}_embedding_idx
          ON ${TABLE} USING hnsw (embedding vector_cosine_ops)
      `);

      // 既存テーブルの次元数が今の埋め込みモデルと違えば、検索は
      // エラーにならず「毎回 0 件」に化ける。起動時に落とす。
      const { rows } = await pool.query<{ dimensions: number | null }>(
        `SELECT atttypmod AS dimensions
           FROM pg_attribute
          WHERE attrelid = $1::regclass AND attname = 'embedding'`,
        [TABLE],
      );
      const actual = rows[0]?.dimensions;
      if (actual !== embedder.dimensions) {
        throw new Error(
          `${TABLE}.embedding の次元数が ${actual} で、埋め込みモデルの ${embedder.dimensions} と一致しません。`,
        );
      }

      logger.info(
        { table: TABLE, dimensions: embedder.dimensions },
        'Long-term memory schema ready',
      );
    },

    async remember(request: RememberInput): Promise<MemoryRecord> {
      const vector = await embedder.embedQuery(request.content);
      const { rows } = await pool.query<MemoryRow>(
        `INSERT INTO ${TABLE} (speaker_id, content, embedding)
         VALUES ($1, $2, $3::vector)
         RETURNING id, speaker_id, content, recorded_at`,
        [request.speakerId ?? null, request.content, toVectorLiteral(vector)],
      );
      const row = rows[0];
      if (!row) throw new Error('長期記憶の保存で行が返りませんでした。');
      return toRecord(row);
    },

    async recall(request: RecallInput): Promise<MemorySearchHit[]> {
      const vector = await embedder.embedQuery(request.query);
      // 話者で絞るのは呼び出し側が明示したときだけ（→ D-35, F-05）。
      const { rows } = await pool.query<MemoryRow & { score: number }>(
        `SELECT id, speaker_id, content, recorded_at,
                1 - (embedding <=> $1::vector) AS score
           FROM ${TABLE}
          WHERE $3::text IS NULL OR speaker_id = $3
          ORDER BY embedding <=> $1::vector
          LIMIT $2`,
        [toVectorLiteral(vector), request.limit, request.speakerId ?? null],
      );
      return rows.map((row) => ({
        ...toRecord(row),
        score: Number(row.score),
      }));
    },

    async list(limit: number): Promise<MemoryRecord[]> {
      const { rows } = await pool.query<MemoryRow>(
        `SELECT id, speaker_id, content, recorded_at
           FROM ${TABLE}
          ORDER BY recorded_at DESC
          LIMIT $1`,
        [limit],
      );
      return rows.map(toRecord);
    },

    async forget(id: string): Promise<boolean> {
      const result = await pool.query(`DELETE FROM ${TABLE} WHERE id = $1`, [
        id,
      ]);
      return (result.rowCount ?? 0) > 0;
    },

    async close() {
      await pool.end();
    },
  };
}
