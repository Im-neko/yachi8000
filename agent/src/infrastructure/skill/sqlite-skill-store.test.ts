import { beforeEach, describe, expect, it } from 'vitest';
import type { SkillStore } from '../../domain/ports/skill-store.ts';
import type { SkillKind } from '../../domain/skill.ts';
import { openAppDatabase } from '../db/app-database.ts';
import { createSqliteSkillStore } from './sqlite-skill-store.ts';

function propose(
  store: SkillStore,
  name: string,
  kind: SkillKind = 'knowledge',
) {
  return store.propose({
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
    const candidate = propose(store, 'first-skill');
    expect(candidate.status).toBe('pending');
    expect(store.mountable(['knowledge', 'persona'])).toHaveLength(0);
  });

  // 名前は全体で一意（→ D-35）。Flue のスキル名がひとつの名前空間だから。
  it('同名は登録できない（却下済みも名前を占有する）', () => {
    const candidate = propose(store, 'dup');
    store.transition(candidate.id, ['pending'], 'rejected');
    expect(() => propose(store, 'dup')).toThrow(/既に使われています/);
  });

  it('承認するとマウント対象になる', () => {
    const candidate = propose(store, 'approved-skill');
    store.transition(candidate.id, ['pending'], 'approved');
    expect(
      store.mountable(['knowledge', 'persona']).map((s) => s.name),
    ).toEqual(['approved-skill']);
  });

  it('固定モードでは人格に関わるものがマウント対象から外れる（Q-16）', () => {
    const knowledge = propose(store, 'a-knowledge', 'knowledge');
    const persona = propose(store, 'a-persona', 'persona');
    store.transition(knowledge.id, ['pending'], 'approved');
    store.transition(persona.id, ['pending'], 'approved');

    expect(store.mountable(['knowledge']).map((s) => s.name)).toEqual([
      'a-knowledge',
    ]);
    expect(store.mountable(['knowledge', 'persona'])).toHaveLength(2);
  });

  // 提案は fire-and-forget で非同期に届く。現在の状態を条件にしないと、
  // 届いた順で結果が変わる（→ D-04 の「承認との競合順序を決めておく」）。
  it('遷移は現在の状態で条件付けられる', () => {
    const candidate = propose(store, 'guarded');
    // pending からは approved へ行ける。
    expect(
      store.transition(candidate.id, ['pending'], 'approved'),
    ).toBeDefined();
    // 承認済みを pending 前提で動かそうとしても動かない。
    expect(
      store.transition(candidate.id, ['pending'], 'rejected'),
    ).toBeUndefined();
    expect(store.get(candidate.id)?.status).toBe('approved');
  });

  it('無効化した承認済みスキルは承認し直せる（F-43）', () => {
    const candidate = propose(store, 'toggled');
    store.transition(candidate.id, ['pending'], 'approved');
    expect(
      store.transition(candidate.id, ['approved'], 'disabled'),
    ).toBeDefined();
    expect(store.mountable(['knowledge'])).toHaveLength(0);
    expect(
      store.transition(candidate.id, ['pending', 'disabled'], 'approved'),
    ).toBeDefined();
    expect(store.mountable(['knowledge'])).toHaveLength(1);
  });

  it('一括却下は pending だけを動かす', () => {
    const pending = propose(store, 'still-pending');
    const approved = propose(store, 'already-approved');
    store.transition(approved.id, ['pending'], 'approved');

    expect(store.rejectAllPending()).toBe(1);
    expect(store.get(pending.id)?.status).toBe('rejected');
    expect(store.get(approved.id)?.status).toBe('approved');
  });

  it('知らない ID は動かせない', () => {
    expect(
      store.transition('いない-id', ['pending'], 'approved'),
    ).toBeUndefined();
    expect(store.get('いない-id')).toBeUndefined();
  });

  it('状態を指定しない一覧は空を返す（全件に化けない）', () => {
    propose(store, 'anything');
    expect(store.list([])).toHaveLength(0);
    expect(store.mountable([])).toHaveLength(0);
  });
});
