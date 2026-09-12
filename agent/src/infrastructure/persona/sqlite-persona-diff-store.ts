import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PersonaDiff } from '../../domain/persona.ts';
import type {
  PersonaDiffRecord,
  PersonaDiffStore,
  RecordPersonaDiffInput,
} from '../../domain/ports/persona-diff-store.ts';
import type { TenantId } from '../../domain/tenant.ts';

interface PersonaDiffRow {
  id: string;
  tenant_id: string;
  instruction: string;
  reason: string;
  recorded_at: string;
  reverted_at: string | null;
}

function toDiff(row: PersonaDiffRow): PersonaDiff {
  return {
    id: row.id,
    recordedAt: row.recorded_at,
    instruction: row.instruction,
    reason: row.reason,
  };
}

/**
 * 人格差分の SQLite 実装（F-33）。
 *
 * 静的設定（設定ファイル）とは**別の実体**。混ぜると一方の書き手が他方を
 * 消す（INV-8, D-12）。ここへ書くのはプロセスだけで、人は触らない。
 */
export function createSqlitePersonaDiffStore(
  db: DatabaseSync,
): PersonaDiffStore {
  const insert = db.prepare(
    `INSERT INTO persona_diffs
       (id, tenant_id, instruction, reason, recorded_at, reverted_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  );
  const selectActive = db.prepare(
    `SELECT * FROM persona_diffs
      WHERE tenant_id = ? AND reverted_at IS NULL
      ORDER BY recorded_at ASC`,
  );
  const selectHistory = db.prepare(
    `SELECT * FROM persona_diffs
      WHERE tenant_id = ?
      ORDER BY recorded_at DESC
      LIMIT ?`,
  );
  const revertOne = db.prepare(
    `UPDATE persona_diffs SET reverted_at = ?
      WHERE tenant_id = ? AND id = ? AND reverted_at IS NULL`,
  );
  const revertEvery = db.prepare(
    `UPDATE persona_diffs SET reverted_at = ?
      WHERE tenant_id = ? AND reverted_at IS NULL`,
  );

  return {
    list(tenantId: TenantId): readonly PersonaDiff[] {
      return (selectActive.all(tenantId) as unknown as PersonaDiffRow[]).map(
        toDiff,
      );
    },

    history(tenantId: TenantId, limit: number): readonly PersonaDiffRecord[] {
      return (
        selectHistory.all(tenantId, limit) as unknown as PersonaDiffRow[]
      ).map((row) => ({
        ...toDiff(row),
        revertedAt: row.reverted_at ?? undefined,
      }));
    },

    record(input: RecordPersonaDiffInput): PersonaDiff {
      const diff: PersonaDiff = {
        id: randomUUID(),
        recordedAt: new Date().toISOString(),
        instruction: input.instruction,
        reason: input.reason,
      };
      insert.run(
        diff.id,
        input.tenantId,
        diff.instruction,
        diff.reason,
        diff.recordedAt,
      );
      return diff;
    },

    revert(tenantId: TenantId, id: string): boolean {
      return revertOne.run(new Date().toISOString(), tenantId, id).changes > 0;
    },

    revertAll(tenantId: TenantId): number {
      return Number(
        revertEvery.run(new Date().toISOString(), tenantId).changes,
      );
    },
  };
}
