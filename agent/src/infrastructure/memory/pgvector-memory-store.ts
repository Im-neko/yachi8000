import { Pool } from 'pg';
import type { MemoryRecord, MemorySearchHit } from '../../domain/memory.ts';
import type { Embedder } from '../../domain/ports/embedder.ts';
import type {
  MemoryStore,
  RecallInput,
  RememberInput,
} from '../../domain/ports/memory-store.ts';
import type { TenantId } from '../../domain/tenant.ts';
import { logger } from '../../observability/logger.ts';

const TABLE = 'long_term_memories';

interface MemoryRow {
  id: string;
  tenant_id: string;
  speaker_id: string | null;
  content: string;
  recorded_at: Date;
}

function toRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id as TenantId,
    speakerId: row.speaker_id ?? undefined,
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
          tenant_id text NOT NULL,
          speaker_id text,
          content text NOT NULL,
          embedding vector(${embedder.dimensions}) NOT NULL,
          recorded_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      // テナント分離は WHERE tenant_id = $1 で行うので、絞り込みと並び替えを
      // 同時に効かせられるよう tenant_id を先頭に置く（F-30）。
      await pool.query(`
        CREATE INDEX IF NOT EXISTS ${TABLE}_tenant_recorded_idx
          ON ${TABLE} (tenant_id, recorded_at DESC)
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
        `INSERT INTO ${TABLE} (tenant_id, speaker_id, content, embedding)
         VALUES ($1, $2, $3, $4::vector)
         RETURNING id, tenant_id, speaker_id, content, recorded_at`,
        [
          request.tenantId,
          request.speakerId ?? null,
          request.content,
          toVectorLiteral(vector),
        ],
      );
      const row = rows[0];
      if (!row) throw new Error('長期記憶の保存で行が返りませんでした。');
      return toRecord(row);
    },

    async recall(request: RecallInput): Promise<MemorySearchHit[]> {
      const vector = await embedder.embedQuery(request.query);
      const { rows } = await pool.query<MemoryRow & { score: number }>(
        `SELECT id, tenant_id, speaker_id, content, recorded_at,
                1 - (embedding <=> $2::vector) AS score
           FROM ${TABLE}
          WHERE tenant_id = $1
          ORDER BY embedding <=> $2::vector
          LIMIT $3`,
        [request.tenantId, toVectorLiteral(vector), request.limit],
      );
      return rows.map((row) => ({
        ...toRecord(row),
        score: Number(row.score),
      }));
    },

    async list(tenantId: TenantId, limit: number): Promise<MemoryRecord[]> {
      const { rows } = await pool.query<MemoryRow>(
        `SELECT id, tenant_id, speaker_id, content, recorded_at
           FROM ${TABLE}
          WHERE tenant_id = $1
          ORDER BY recorded_at DESC
          LIMIT $2`,
        [tenantId, limit],
      );
      return rows.map(toRecord);
    },

    async forget(tenantId: TenantId, id: string): Promise<boolean> {
      const result = await pool.query(
        `DELETE FROM ${TABLE} WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async close() {
      await pool.end();
    },
  };
}
