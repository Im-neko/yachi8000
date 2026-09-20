import { beforeEach, describe, expect, it } from 'vitest';
import type { PersonaDiffStore } from '../../domain/ports/persona-diff-store.ts';
import { openAppDatabase } from '../db/app-database.ts';
import { createSqlitePersonaDiffStore } from './sqlite-persona-diff-store.ts';

describe('createSqlitePersonaDiffStore', () => {
  let store: PersonaDiffStore;

  beforeEach(() => {
    store = createSqlitePersonaDiffStore(openAppDatabase(':memory:'));
  });

  it('記録した差分を読み出せる', () => {
    const diff = store.record({
      instruction: 'もう少し砕けた口調で話す',
      reason: '利用者が「かたい」と言った',
    });
    expect(store.list().map((d) => d.id)).toEqual([diff.id]);
  });

  it('巻き戻すと適用対象から外れるが、履歴には残る（F-33）', () => {
    const diff = store.record({ instruction: 'i', reason: 'r' });
    expect(store.revert(diff.id)).toBe(true);
    expect(store.list()).toHaveLength(0);

    const [record] = store.history(10);
    expect(record?.id).toBe(diff.id);
    expect(record?.revertedAt).toBeDefined();
  });

  it('同じ差分は二度巻き戻せない', () => {
    const diff = store.record({ instruction: 'i', reason: 'r' });
    expect(store.revert(diff.id)).toBe(true);
    expect(store.revert(diff.id)).toBe(false);
  });

  it('知らない ID は巻き戻せない', () => {
    store.record({ instruction: 'i', reason: 'r' });
    expect(store.revert('いない-id')).toBe(false);
    expect(store.list()).toHaveLength(1);
  });

  it('一括巻き戻しは既定の人格に戻す（引き算で済む。D-12）', () => {
    store.record({ instruction: 'i1', reason: 'r' });
    store.record({ instruction: 'i2', reason: 'r' });

    expect(store.revertAll()).toBe(2);
    expect(store.list()).toHaveLength(0);
    expect(store.history(10)).toHaveLength(2);
  });

  it('一括巻き戻しは既に巻き戻したものを数えない', () => {
    const diff = store.record({ instruction: 'i', reason: 'r' });
    store.revert(diff.id);
    expect(store.revertAll()).toBe(0);
  });
});
