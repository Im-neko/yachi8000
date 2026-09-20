import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PersonaDiff } from '../../domain/persona.ts';
import type {
  PersonaDiffRecord,
  PersonaDiffStore,
  RecordPersonaDiffInput,
} from '../../domain/ports/persona-diff-store.ts';

interface PersonaDiffRow {
  id: string;
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
 *
 * **人格はひとつ**なので、場や相手では分けない（→ D-35）。ここへ入った
 * 変化は以後の全応答に効く（F-33 の既知の限界）。
 */
export function createSqlitePersonaDiffStore(
  db: DatabaseSync,
): PersonaDiffStore {
  const insert = db.prepare(
    `INSERT INTO persona_diffs
       (id, instruction, reason, recorded_at, reverted_at)
     VALUES (?, ?, ?, ?, NULL)`,
  );
  const selectActive = db.prepare(
    `SELECT * FROM persona_diffs
      WHERE reverted_at IS NULL
      ORDER BY recorded_at ASC`,
  );
  const selectHistory = db.prepare(
    `SELECT * FROM persona_diffs
      ORDER BY recorded_at DESC
      LIMIT ?`,
  );
  const revertOne = db.prepare(
    `UPDATE persona_diffs SET reverted_at = ?
      WHERE id = ? AND reverted_at IS NULL`,
  );
  const revertEvery = db.prepare(
    `UPDATE persona_diffs SET reverted_at = ?
      WHERE reverted_at IS NULL`,
  );

  return {
    list(): readonly PersonaDiff[] {
      return (selectActive.all() as unknown as PersonaDiffRow[]).map(toDiff);
    },

    history(limit: number): readonly PersonaDiffRecord[] {
      return (selectHistory.all(limit) as unknown as PersonaDiffRow[]).map(
        (row) => ({
          ...toDiff(row),
          revertedAt: row.reverted_at ?? undefined,
        }),
      );
    },

    record(input: RecordPersonaDiffInput): PersonaDiff {
      const diff: PersonaDiff = {
        id: randomUUID(),
        recordedAt: new Date().toISOString(),
        instruction: input.instruction,
        reason: input.reason,
      };
      insert.run(diff.id, diff.instruction, diff.reason, diff.recordedAt);
      return diff;
    },

    revert(id: string): boolean {
      return revertOne.run(new Date().toISOString(), id).changes > 0;
    },

    revertAll(): number {
      return Number(revertEvery.run(new Date().toISOString()).changes);
    },
  };
}
