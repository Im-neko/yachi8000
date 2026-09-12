import { beforeEach, describe, expect, it } from 'vitest';
import type { ReminderStore } from '../../domain/ports/reminder-store.ts';
import type { TenantId } from '../../domain/tenant.ts';
import { openAppDatabase } from '../db/app-database.ts';
import { createSqliteReminderStore } from './sqlite-reminder-store.ts';

const A = 'discord-guild-1' as TenantId;
const B = 'discord-guild-2' as TenantId;

function schedule(
  store: ReminderStore,
  tenantId: TenantId,
  dueAt: string,
  title = 'やること',
) {
  return store.schedule({
    tenantId,
    title,
    description: undefined,
    dueAt,
    channelId: 'c1',
    guildId: 'g1',
    createdBy: 'u1',
  });
}

describe('createSqliteReminderStore', () => {
  let store: ReminderStore;

  beforeEach(() => {
    store = createSqliteReminderStore(openAppDatabase(':memory:'));
  });

  it('未発火のものを期限の昇順で返す', () => {
    schedule(store, A, '2026-09-13T00:00:00.000Z', '後');
    schedule(store, A, '2026-09-12T00:00:00.000Z', '先');
    expect(store.listPending(A).map((r) => r.title)).toEqual(['先', '後']);
  });

  it('別テナントのものは見えない', () => {
    schedule(store, A, '2026-09-12T00:00:00.000Z');
    expect(store.listPending(B)).toHaveLength(0);
  });

  it('別テナントの ID は消せない', () => {
    const reminder = schedule(store, A, '2026-09-12T00:00:00.000Z');
    expect(store.cancel(B, reminder.id)).toBe(false);
    expect(store.listPending(A)).toHaveLength(1);
    expect(store.cancel(A, reminder.id)).toBe(true);
    expect(store.listPending(A)).toHaveLength(0);
  });

  it('期限が来ていないものは claim しない', () => {
    schedule(store, A, '2026-09-12T10:00:00.000Z');
    expect(store.claimDue('2026-09-12T09:59:00.000Z')).toHaveLength(0);
  });

  // 二重に読み上げるのが最悪の壊れ方。印を先に立てることで、2 度目は
  // 何も取れない（→ D-23）。
  it('同じリマインダーは一度しか claim できない', () => {
    schedule(store, A, '2026-09-12T09:00:00.000Z');
    const first = store.claimDue('2026-09-12T10:00:00.000Z');
    expect(first).toHaveLength(1);
    expect(first[0]?.firedAt).toBe('2026-09-12T10:00:00.000Z');

    expect(store.claimDue('2026-09-12T10:00:00.000Z')).toHaveLength(0);
  });

  it('claim したものは一覧と削除の対象から外れる', () => {
    const reminder = schedule(store, A, '2026-09-12T09:00:00.000Z');
    store.claimDue('2026-09-12T10:00:00.000Z');
    expect(store.listPending(A)).toHaveLength(0);
    expect(store.cancel(A, reminder.id)).toBe(false);
  });

  it('テナントをまたいで期限が来たものをまとめて取る（poller は全体を見る）', () => {
    schedule(store, A, '2026-09-12T09:00:00.000Z');
    schedule(store, B, '2026-09-12T08:00:00.000Z');
    expect(store.claimDue('2026-09-12T10:00:00.000Z')).toHaveLength(2);
  });

  it('補足は null と undefined を往復させる', () => {
    const withDescription = store.schedule({
      tenantId: A,
      title: 'やること',
      description: 'くわしく',
      dueAt: '2026-09-12T09:00:00.000Z',
      channelId: 'c1',
      guildId: undefined,
      createdBy: undefined,
    });
    const [stored] = store.listPending(A);
    expect(stored?.description).toBe('くわしく');
    expect(stored?.guildId).toBeUndefined();
    expect(stored?.createdBy).toBeUndefined();
    expect(stored?.id).toBe(withDescription.id);
  });
});
