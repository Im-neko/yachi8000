import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ProposeSkillInput,
  SkillStore,
} from '../../domain/ports/skill-store.ts';
import type {
  SkillCandidate,
  SkillKind,
  SkillStatus,
} from '../../domain/skill.ts';
import type { TenantId } from '../../domain/tenant.ts';

interface SkillRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  instructions: string;
  kind: string;
  status: string;
  proposed_at: string;
  decided_at: string | null;
}

function toCandidate(row: SkillRow): SkillCandidate {
  return {
    id: row.id,
    tenantId: row.tenant_id as TenantId,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    kind: row.kind as SkillKind,
    status: row.status as SkillStatus,
    proposedAt: row.proposed_at,
    decidedAt: row.decided_at ?? undefined,
  };
}

/** `IN (?, ?, …)` を件数ぶん組み立てる。列挙は呼び出し側が閉じた集合で渡す。 */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * スキル候補の SQLite 実装（F-40〜F-43）。
 *
 * 状態の書き換えはすべて `WHERE status IN (…)` を伴う。現在の状態を条件に
 * しないと、非同期に届く提案と承認操作の順序で結果が変わる
 * （→ 04-architecture.md の「共有される書き込み先の棚卸し」が求める
 * 「提案は fire-and-forget。承認との競合順序を決めておく」）。
 */
export function createSqliteSkillStore(db: DatabaseSync): SkillStore {
  const insert = db.prepare(
    `INSERT INTO skills
       (id, tenant_id, name, description, instructions, kind, status, proposed_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
  );
  const selectById = db.prepare(
    `SELECT * FROM skills WHERE tenant_id = ? AND id = ?`,
  );
  const rejectPending = db.prepare(
    `UPDATE skills SET status = 'rejected', decided_at = ?
      WHERE tenant_id = ? AND status = 'pending'`,
  );

  function get(tenantId: TenantId, id: string): SkillCandidate | undefined {
    const row = selectById.get(tenantId, id) as unknown as SkillRow | undefined;
    return row ? toCandidate(row) : undefined;
  }

  return {
    propose(input: ProposeSkillInput): SkillCandidate {
      const candidate: SkillCandidate = {
        id: randomUUID(),
        tenantId: input.tenantId,
        name: input.name.trim(),
        description: input.description.trim(),
        instructions: input.instructions.trim(),
        kind: input.kind,
        status: 'pending',
        proposedAt: new Date().toISOString(),
        decidedAt: undefined,
      };
      try {
        insert.run(
          candidate.id,
          candidate.tenantId,
          candidate.name,
          candidate.description,
          candidate.instructions,
          candidate.kind,
          candidate.proposedAt,
        );
      } catch (error) {
        // UNIQUE (tenant_id, name) の衝突。却下済みの名前も残っているので、
        // 「同じ名前で出し直せない」ことを呼び出し側へそのまま伝える。
        throw new Error(
          `スキル名 "${candidate.name}" は既に使われています（却下済みのものも名前を占有します）。別の名前にしてください。(${(error as Error).message})`,
        );
      }
      return candidate;
    },

    list(
      tenantId: TenantId,
      statuses: readonly SkillStatus[],
    ): readonly SkillCandidate[] {
      if (statuses.length === 0) return [];
      const rows = db
        .prepare(
          `SELECT * FROM skills
            WHERE tenant_id = ? AND status IN (${placeholders(statuses.length)})
            ORDER BY proposed_at ASC`,
        )
        .all(tenantId, ...statuses) as unknown as SkillRow[];
      return rows.map(toCandidate);
    },

    get,

    transition(
      tenantId: TenantId,
      id: string,
      from: readonly SkillStatus[],
      to: SkillStatus,
    ): SkillCandidate | undefined {
      if (from.length === 0) return undefined;
      const changed = db
        .prepare(
          `UPDATE skills SET status = ?, decided_at = ?
            WHERE tenant_id = ? AND id = ? AND status IN (${placeholders(from.length)})`,
        )
        .run(to, new Date().toISOString(), tenantId, id, ...from).changes;
      if (changed === 0) return undefined;
      return get(tenantId, id);
    },

    rejectAllPending(tenantId: TenantId): number {
      return Number(
        rejectPending.run(new Date().toISOString(), tenantId).changes,
      );
    },

    mountable(
      tenantId: TenantId,
      kinds: readonly SkillKind[],
    ): readonly SkillCandidate[] {
      if (kinds.length === 0) return [];
      const rows = db
        .prepare(
          `SELECT * FROM skills
            WHERE tenant_id = ? AND status = 'approved'
              AND kind IN (${placeholders(kinds.length)})
            ORDER BY proposed_at ASC`,
        )
        .all(tenantId, ...kinds) as unknown as SkillRow[];
      return rows.map(toCandidate);
    },
  };
}
