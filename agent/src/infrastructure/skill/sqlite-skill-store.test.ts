import { beforeEach, describe, expect, it } from 'vitest';
import type { SkillStore } from '../../domain/ports/skill-store.ts';
import type { SkillKind } from '../../domain/skill.ts';
import type { TenantId } from '../../domain/tenant.ts';
import { openAppDatabase } from '../db/app-database.ts';
import { createSqliteSkillStore } from './sqlite-skill-store.ts';

const A = 'discord-guild-1' as TenantId;
const B = 'discord-guild-2' as TenantId;

function propose(
  store: SkillStore,
  tenantId: TenantId,
  name: string,
  kind: SkillKind = 'knowledge',
) {
  return store.propose({
    tenantId,
    name,
    description: `${name} の説明`,
    instructions: `${name} の本文`,
    kind,
  });
}

describe('createSqliteSkillStore', () => {
  let store: SkillStore;

  beforeEach(() => {
    store = createSqliteSkillStore(openAppDatabase(':memory:'));
  });

  it('提案は pending として入る（承認まで応答に出ない）', () => {
    const candidate = propose(store, A, 'first-skill');
    expect(candidate.status).toBe('pending');
    expect(store.mountable(A, ['knowledge', 'persona'])).toHaveLength(0);
  });

  it('同じテナントで同名は登録できない（却下済みも名前を占有する）', () => {
    const candidate = propose(store, A, 'dup');
    store.transition(A, candidate.id, ['pending'], 'rejected');
    expect(() => propose(store, A, 'dup')).toThrow(/既に使われています/);
  });

  it('別テナントなら同名でよい', () => {
    propose(store, A, 'same-name');
    expect(() => propose(store, B, 'same-name')).not.toThrow();
  });

  it('承認するとマウント対象になる', () => {
    const candidate = propose(store, A, 'approved-skill');
    store.transition(A, candidate.id, ['pending'], 'approved');
    expect(
      store.mountable(A, ['knowledge', 'persona']).map((s) => s.name),
    ).toEqual(['approved-skill']);
  });

  it('固定モードでは人格に関わるものがマウント対象から外れる（Q-16）', () => {
    const knowledge = propose(store, A, 'a-knowledge', 'knowledge');
    const persona = propose(store, A, 'a-persona', 'persona');
    store.transition(A, knowledge.id, ['pending'], 'approved');
    store.transition(A, persona.id, ['pending'], 'approved');

    expect(store.mountable(A, ['knowledge']).map((s) => s.name)).toEqual([
      'a-knowledge',
    ]);
    expect(store.mountable(A, ['knowledge', 'persona'])).toHaveLength(2);
  });

  // 提案は fire-and-forget で非同期に届く。現在の状態を条件にしないと、
  // 届いた順で結果が変わる（→ D-04 の「承認との競合順序を決めておく」）。
  it('遷移は現在の状態で条件付けられる', () => {
    const candidate = propose(store, A, 'guarded');
    // pending からは approved へ行ける。
    expect(
      store.transition(A, candidate.id, ['pending'], 'approved'),
    ).toBeDefined();
    // 承認済みを pending 前提で動かそうとしても動かない。
    expect(
      store.transition(A, candidate.id, ['pending'], 'rejected'),
    ).toBeUndefined();
    expect(store.get(A, candidate.id)?.status).toBe('approved');
  });

  it('無効化した承認済みスキルは承認し直せる（F-43）', () => {
    const candidate = propose(store, A, 'toggled');
    store.transition(A, candidate.id, ['pending'], 'approved');
    expect(
      store.transition(A, candidate.id, ['approved'], 'disabled'),
    ).toBeDefined();
    expect(store.mountable(A, ['knowledge'])).toHaveLength(0);
    expect(
      store.transition(A, candidate.id, ['pending', 'disabled'], 'approved'),
    ).toBeDefined();
    expect(store.mountable(A, ['knowledge'])).toHaveLength(1);
  });

  it('一括却下は pending だけを動かす', () => {
    const pending = propose(store, A, 'still-pending');
    const approved = propose(store, A, 'already-approved');
    store.transition(A, approved.id, ['pending'], 'approved');
    propose(store, B, 'other-tenant');

    expect(store.rejectAllPending(A)).toBe(1);
    expect(store.get(A, pending.id)?.status).toBe('rejected');
    expect(store.get(A, approved.id)?.status).toBe('approved');
    expect(store.list(B, ['pending'])).toHaveLength(1);
  });

  it('別テナントの ID は動かせない', () => {
    const candidate = propose(store, A, 'isolated');
    expect(
      store.transition(B, candidate.id, ['pending'], 'approved'),
    ).toBeUndefined();
    expect(store.get(B, candidate.id)).toBeUndefined();
  });

  it('状態を指定しない一覧は空を返す（全件に化けない）', () => {
    propose(store, A, 'anything');
    expect(store.list(A, [])).toHaveLength(0);
    expect(store.mountable(A, [])).toHaveLength(0);
  });
});
