import type { DatabaseSync } from 'node:sqlite';
import type { OpsFinding, OpsOverall, OpsSnapshot } from '../../domain/ops.ts';
import type {
  OpsReviewRecord,
  OpsReviewStore,
} from '../../domain/ports/ops-review-store.ts';

/** 残す見回りの数。日次なので約 3 か月ぶん。 */
const KEEP_REVIEWS = 90;

interface ReviewRow {
  id: string;
  reviewed_at: string;
  status: string;
  severity: string;
  findings: string;
  snapshot: string | null;
  narration: string | null;
  error: string | null;
  notes: string;
}

/**
 * JSON の列は**壊れていたら落とす**（`JSON.parse` がそのまま投げる）。
 * 読めない行を黙って空にすると、平常の基準が欠けて傾向の判定がずれる。
 */
function toRecord(row: ReviewRow): OpsReviewRecord {
  return {
    id: row.id,
    reviewedAt: row.reviewed_at,
    status: row.status === 'failed' ? 'failed' : 'completed',
    severity: row.severity as OpsOverall,
    findings: JSON.parse(row.findings) as OpsFinding[],
    snapshot:
      row.snapshot === null
        ? undefined
        : (JSON.parse(row.snapshot) as OpsSnapshot),
    narration: row.narration ?? undefined,
    error: row.error ?? undefined,
    notes: JSON.parse(row.notes) as string[],
  };
}

/** 見回りの結果の SQLite 実装（F-53, → D-24）。 */
export function createSqliteOpsReviewStore(db: DatabaseSync): OpsReviewStore {
  const insert = db.prepare(
    `INSERT INTO ops_reviews
       (id, reviewed_at, status, severity, findings, snapshot, narration, error, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const prune = db.prepare(
    `DELETE FROM ops_reviews
      WHERE id NOT IN (
        SELECT id FROM ops_reviews ORDER BY reviewed_at DESC LIMIT ?
      )`,
  );
  const selectLatest = db.prepare(
    `SELECT * FROM ops_reviews ORDER BY reviewed_at DESC LIMIT 1`,
  );
  const selectSnapshots = db.prepare(
    `SELECT snapshot FROM ops_reviews
      WHERE status = 'completed' AND snapshot IS NOT NULL
      ORDER BY reviewed_at DESC LIMIT ?`,
  );

  return {
    save(record) {
      insert.run(
        record.id,
        record.reviewedAt,
        record.status,
        record.severity,
        JSON.stringify(record.findings),
        record.snapshot === undefined ? null : JSON.stringify(record.snapshot),
        record.narration ?? null,
        record.error ?? null,
        JSON.stringify(record.notes),
      );
      prune.run(KEEP_REVIEWS);
    },

    latest() {
      const row = selectLatest.get() as unknown as ReviewRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },

    recentSnapshots(limit) {
      const rows = selectSnapshots.all(limit) as unknown as {
        snapshot: string;
      }[];
      return rows.map((row) => JSON.parse(row.snapshot) as OpsSnapshot);
    },
  };
}
