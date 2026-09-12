import { beforeEach, describe, expect, it } from 'vitest';
import type { PersonaDiff } from '../domain/persona.ts';
import type {
  PersonaDiffRecord,
  PersonaDiffStore,
  RecordPersonaDiffInput,
} from '../domain/ports/persona-diff-store.ts';
import type { Settings } from '../domain/settings.ts';
import type { TenantId } from '../domain/tenant.ts';
import {
  buildPersonaPrompt,
  isPersonaLocked,
  listPersonaChanges,
  type PersonaDependencies,
  recordPersonaChange,
  resetPersona,
  revertPersonaChange,
} from './persona.ts';

const TENANT = 'discord-guild-1' as TenantId;

const PROFILE = {
  identity: { name: 'やち', userAddress: 'あなた' },
  persona: {
    firstPerson: 'わたし',
    personality: 'おだやか。',
    speechStyle: 'ですます調。',
  },
} as const;

/**
 * PersonaDiffStore の代役。
 *
 * **SQL 側の契約は `infrastructure/persona/sqlite-persona-diff-store.test.ts`
 * が受け持つ。** ここで確かめるのは、固定モードで差分を読まないこと
 * （D-13 の決定的な防御）と、記録の入口の検査。
 */
function createFakePersonaDiffStore(): PersonaDiffStore {
  const rows: Array<PersonaDiffRecord & { tenantId: TenantId }> = [];
  let nextId = 0;

  return {
    list(tenantId) {
      return rows.filter(
        (row) => row.tenantId === tenantId && row.revertedAt === undefined,
      );
    },

    history(tenantId, limit) {
      return rows
        .filter((row) => row.tenantId === tenantId)
        .slice(-limit)
        .reverse();
    },

    record(input: RecordPersonaDiffInput): PersonaDiff {
      const diff: PersonaDiff = {
        id: `d${++nextId}`,
        recordedAt: new Date().toISOString(),
        instruction: input.instruction,
        reason: input.reason,
      };
      rows.push({ ...diff, tenantId: input.tenantId, revertedAt: undefined });
      return diff;
    },

    revert(tenantId, id) {
      const index = rows.findIndex(
        (row) =>
          row.tenantId === tenantId &&
          row.id === id &&
          row.revertedAt === undefined,
      );
      if (index < 0) return false;
      const current = rows[index];
      if (!current) return false;
      rows[index] = { ...current, revertedAt: new Date().toISOString() };
      return true;
    },

    revertAll(tenantId) {
      let reverted = 0;
      for (const [index, row] of rows.entries()) {
        if (row.tenantId !== tenantId || row.revertedAt !== undefined) continue;
        rows[index] = { ...row, revertedAt: new Date().toISOString() };
        reverted += 1;
      }
      return reverted;
    },
  };
}

function createDeps(personaLock: boolean): PersonaDependencies {
  return {
    settings: {
      get: () =>
        ({ ...PROFILE, behavior: { personaLock } }) as unknown as Settings,
    },
    diffs: createFakePersonaDiffStore(),
    log: { info: () => undefined },
  };
}

describe('recordPersonaChange', () => {
  let deps: PersonaDependencies;

  beforeEach(() => {
    deps = createDeps(false);
  });

  it('記録した差分がプロンプトに乗る', () => {
    recordPersonaChange(deps, {
      tenantId: TENANT,
      instruction: '短く答える',
      reason: '利用者が「長い」と言った',
    });
    expect(buildPersonaPrompt(deps, TENANT)).toContain('短く答える');
  });

  it('契機のない記録は拒む（F-33 は「なぜ変わったか」を求める）', () => {
    expect(() =>
      recordPersonaChange(deps, {
        tenantId: TENANT,
        instruction: '短く答える',
        reason: '  ',
      }),
    ).toThrow(/契機/);
  });

  it('空の指示は拒む', () => {
    expect(() =>
      recordPersonaChange(deps, {
        tenantId: TENANT,
        instruction: '  ',
        reason: 'r',
      }),
    ).toThrow(/空の指示/);
  });
});

describe('固定モード（F-34, D-13）', () => {
  it('記録は続けるが、プロンプトには乗せない', () => {
    const deps = createDeps(true);
    recordPersonaChange(deps, {
      tenantId: TENANT,
      instruction: '砕けて話す',
      reason: '頼まれた',
    });

    expect(isPersonaLocked(deps)).toBe(true);
    expect(listPersonaChanges(deps, TENANT)).toHaveLength(1);
    expect(buildPersonaPrompt(deps, TENANT)).not.toContain('砕けて話す');
    expect(buildPersonaPrompt(deps, TENANT)).toContain('変更してはいけません');
  });
});

describe('巻き戻し（F-33）', () => {
  let deps: PersonaDependencies;

  beforeEach(() => {
    deps = createDeps(false);
  });

  it('個別に戻すとプロンプトから外れる', () => {
    const diff = recordPersonaChange(deps, {
      tenantId: TENANT,
      instruction: '砕けて話す',
      reason: '頼まれた',
    });
    expect(revertPersonaChange(deps, { tenantId: TENANT, id: diff.id })).toBe(
      true,
    );
    expect(buildPersonaPrompt(deps, TENANT)).not.toContain('砕けて話す');
  });

  it('一括で戻すと既定の人格だけになる', () => {
    recordPersonaChange(deps, {
      tenantId: TENANT,
      instruction: 'i1',
      reason: 'r',
    });
    recordPersonaChange(deps, {
      tenantId: TENANT,
      instruction: 'i2',
      reason: 'r',
    });

    expect(resetPersona(deps, TENANT)).toBe(2);
    const prompt = buildPersonaPrompt(deps, TENANT);
    expect(prompt).toContain('やち');
    expect(prompt).not.toContain('身についたこと');
  });
});
