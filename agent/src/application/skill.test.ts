import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ProposeSkillInput,
  SkillStore,
} from '../domain/ports/skill-store.ts';
import type { Settings } from '../domain/settings.ts';
import type { SkillCandidate, SkillStatus } from '../domain/skill.ts';
import type { TenantId } from '../domain/tenant.ts';
import {
  approveSkill,
  disableSkill,
  mountableSkills,
  proposeSkill,
  rejectAllPendingSkills,
  rejectSkill,
  type SkillDependencies,
} from './skill.ts';

const TENANT = 'discord-guild-1' as TenantId;

/**
 * SkillStore の代役。
 *
 * **SQL 側の契約（同名の拒否・テナント分離・状態を条件にした遷移）は
 * `infrastructure/skill/sqlite-skill-store.test.ts` が受け持つ。** ここで
 * 確かめるのは、承認フローと固定モードの絞り込みというユースケースの判断。
 */
function createFakeSkillStore(): SkillStore {
  const rows: SkillCandidate[] = [];
  let nextId = 0;

  function get(tenantId: TenantId, id: string): SkillCandidate | undefined {
    return rows.find((row) => row.tenantId === tenantId && row.id === id);
  }

  return {
    propose(input: ProposeSkillInput): SkillCandidate {
      if (
        rows.some(
          (row) => row.tenantId === input.tenantId && row.name === input.name,
        )
      ) {
        throw new Error(`スキル名 "${input.name}" は既に使われています。`);
      }
      const candidate: SkillCandidate = {
        id: `s${++nextId}`,
        tenantId: input.tenantId,
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        kind: input.kind,
        status: 'pending',
        proposedAt: new Date(1_800_000_000_000 + nextId).toISOString(),
        decidedAt: undefined,
      };
      rows.push(candidate);
      return candidate;
    },

    list(tenantId, statuses) {
      return rows.filter(
        (row) => row.tenantId === tenantId && statuses.includes(row.status),
      );
    },

    get,

    transition(tenantId, id, from, to) {
      const index = rows.findIndex(
        (row) =>
          row.tenantId === tenantId &&
          row.id === id &&
          from.includes(row.status),
      );
      if (index < 0) return undefined;
      const current = rows[index];
      if (!current) return undefined;
      const moved: SkillCandidate = {
        ...current,
        status: to,
        decidedAt: new Date().toISOString(),
      };
      rows[index] = moved;
      return moved;
    },

    rejectAllPending(tenantId) {
      let rejected = 0;
      for (const [index, row] of rows.entries()) {
        if (row.tenantId !== tenantId || row.status !== 'pending') continue;
        rows[index] = {
          ...row,
          status: 'rejected' satisfies SkillStatus,
          decidedAt: new Date().toISOString(),
        };
        rejected += 1;
      }
      return rejected;
    },

    mountable(tenantId, kinds) {
      return rows.filter(
        (row) =>
          row.tenantId === tenantId &&
          row.status === 'approved' &&
          kinds.includes(row.kind),
      );
    },
  };
}

function createDeps(personaLock: boolean): SkillDependencies {
  return {
    store: createFakeSkillStore(),
    settings: {
      get: () => ({ behavior: { personaLock } }) as Settings,
    },
    log: { info: () => undefined, debug: () => undefined },
  };
}

function propose(
  deps: SkillDependencies,
  name: string,
  kind: 'knowledge' | 'persona' = 'knowledge',
) {
  return proposeSkill(deps, {
    tenantId: TENANT,
    name,
    description: `${name} を使う場面`,
    instructions: `${name} の中身`,
    kind,
  });
}

describe('proposeSkill', () => {
  let deps: SkillDependencies;

  beforeEach(() => {
    deps = createDeps(false);
  });

  it('pending として記録する（承認まで応答に出ない）', () => {
    expect(propose(deps, 'ok-skill').status).toBe('pending');
    expect(mountableSkills(deps, TENANT)).toHaveLength(0);
  });

  // 承認まで通してから defineSkill に蹴られると、承認操作か毎ターンの
  // render が壊れる。入口で落とす。
  it('Flue のスキルとして成立しない候補は保存しない', () => {
    expect(() => propose(deps, 'Bad_Name')).toThrow();
    expect(mountableSkills(deps, TENANT)).toHaveLength(0);
  });
});

describe('承認フロー（F-41, F-43）', () => {
  let deps: SkillDependencies;

  beforeEach(() => {
    deps = createDeps(false);
  });

  it('承認するとマウント対象になる', () => {
    const candidate = propose(deps, 'to-approve');
    expect(
      approveSkill(deps, { tenantId: TENANT, id: candidate.id })?.status,
    ).toBe('approved');
    expect(mountableSkills(deps, TENANT).map((s) => s.name)).toEqual([
      'to-approve',
    ]);
  });

  it('却下したものは承認できない', () => {
    const candidate = propose(deps, 'to-reject');
    rejectSkill(deps, { tenantId: TENANT, id: candidate.id });
    expect(
      approveSkill(deps, { tenantId: TENANT, id: candidate.id }),
    ).toBeUndefined();
  });

  it('承認済みを却下しようとしても動かない', () => {
    const candidate = propose(deps, 'already-approved');
    approveSkill(deps, { tenantId: TENANT, id: candidate.id });
    expect(
      rejectSkill(deps, { tenantId: TENANT, id: candidate.id }),
    ).toBeUndefined();
  });

  it('無効化するとマウント対象から外れ、承認し直せる', () => {
    const candidate = propose(deps, 'toggled');
    approveSkill(deps, { tenantId: TENANT, id: candidate.id });
    expect(
      disableSkill(deps, { tenantId: TENANT, id: candidate.id })?.status,
    ).toBe('disabled');
    expect(mountableSkills(deps, TENANT)).toHaveLength(0);
    approveSkill(deps, { tenantId: TENANT, id: candidate.id });
    expect(mountableSkills(deps, TENANT)).toHaveLength(1);
  });

  it('一括却下は pending だけを動かす', () => {
    const pending = propose(deps, 'pending-one');
    const approved = propose(deps, 'approved-one');
    approveSkill(deps, { tenantId: TENANT, id: approved.id });

    expect(rejectAllPendingSkills(deps, TENANT)).toBe(1);
    expect(mountableSkills(deps, TENANT).map((s) => s.name)).toEqual([
      'approved-one',
    ]);
    expect(
      approveSkill(deps, { tenantId: TENANT, id: pending.id }),
    ).toBeUndefined();
  });
});

describe('mountableSkills と固定モード（F-34, Q-16）', () => {
  it('固定モードでは人格に関わるスキルをマウントしない', () => {
    const deps = createDeps(true);
    const knowledge = propose(deps, 'a-knowledge', 'knowledge');
    const persona = propose(deps, 'a-persona', 'persona');
    approveSkill(deps, { tenantId: TENANT, id: knowledge.id });
    approveSkill(deps, { tenantId: TENANT, id: persona.id });

    expect(mountableSkills(deps, TENANT).map((s) => s.name)).toEqual([
      'a-knowledge',
    ]);
  });

  // 固定モードは「読まない」だけ。承認そのものは止めないので、OFF に
  // 戻せば効きはじめる（D-13 と同じ形）。
  it('固定モード中も人格スキルの承認は通る', () => {
    const deps = createDeps(true);
    const persona = propose(deps, 'a-persona', 'persona');
    expect(
      approveSkill(deps, { tenantId: TENANT, id: persona.id })?.status,
    ).toBe('approved');
  });
});
