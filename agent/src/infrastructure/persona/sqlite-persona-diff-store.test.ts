import { beforeEach, describe, expect, it } from 'vitest';
import type { PersonaDiffStore } from '../../domain/ports/persona-diff-store.ts';
import type { TenantId } from '../../domain/tenant.ts';
import { openAppDatabase } from '../db/app-database.ts';
import { createSqlitePersonaDiffStore } from './sqlite-persona-diff-store.ts';

const A = 'discord-guild-1' as TenantId;
const B = 'discord-guild-2' as TenantId;

describe('createSqlitePersonaDiffStore', () => {
  let store: PersonaDiffStore;

  beforeEach(() => {
    store = createSqlitePersonaDiffStore(openAppDatabase(':memory:'));
  });

  it('記録した差分を読み出せる', () => {
    const diff = store.record({
      tenantId: A,
      instruction: 'もう少し砕けた口調で話す',
      reason: '利用者が「かたい」と言った',
    });
    expect(store.list(A).map((d) => d.id)).toEqual([diff.id]);
  });

  it('別テナントの差分は見えない', () => {
    store.record({ tenantId: A, instruction: 'i', reason: 'r' });
    expect(store.list(B)).toHaveLength(0);
  });

  it('巻き戻すと適用対象から外れるが、履歴には残る（F-33）', () => {
    const diff = store.record({ tenantId: A, instruction: 'i', reason: 'r' });
    expect(store.revert(A, diff.id)).toBe(true);
    expect(store.list(A)).toHaveLength(0);

    const [record] = store.history(A, 10);
    expect(record?.id).toBe(diff.id);
    expect(record?.revertedAt).toBeDefined();
  });

  it('同じ差分は二度巻き戻せない', () => {
    const diff = store.record({ tenantId: A, instruction: 'i', reason: 'r' });
    expect(store.revert(A, diff.id)).toBe(true);
    expect(store.revert(A, diff.id)).toBe(false);
  });

  it('別テナントの ID は巻き戻せない', () => {
    const diff = store.record({ tenantId: A, instruction: 'i', reason: 'r' });
    expect(store.revert(B, diff.id)).toBe(false);
    expect(store.list(A)).toHaveLength(1);
  });

  it('一括巻き戻しは既定の人格に戻す（引き算で済む。D-12）', () => {
    store.record({ tenantId: A, instruction: 'i1', reason: 'r' });
    store.record({ tenantId: A, instruction: 'i2', reason: 'r' });
    store.record({ tenantId: B, instruction: 'i3', reason: 'r' });

    expect(store.revertAll(A)).toBe(2);
    expect(store.list(A)).toHaveLength(0);
    expect(store.list(B)).toHaveLength(1);
    expect(store.history(A, 10)).toHaveLength(2);
  });

  it('一括巻き戻しは既に巻き戻したものを数えない', () => {
    const diff = store.record({ tenantId: A, instruction: 'i', reason: 'r' });
    store.revert(A, diff.id);
    expect(store.revertAll(A)).toBe(0);
  });
});
