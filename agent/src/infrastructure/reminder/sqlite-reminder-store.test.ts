import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReminderStore } from '../../domain/ports/reminder-store.ts';
import { createRecurrence } from '../../domain/reminder.ts';
import type { SpeakerId } from '../../domain/speaker.ts';
import { openAppDatabase } from '../db/app-database.ts';
import { createSqliteReminderStore } from './sqlite-reminder-store.ts';

const A = 'discord-user-1' as SpeakerId;
const B = 'discord-user-2' as SpeakerId;

function schedule(
  store: ReminderStore,
  createdBy: SpeakerId,
  dueAt: string,
  title = 'やること',
) {
  return store.schedule({
    title,
    description: undefined,
    dueAt,
    recurrence: undefined,
    channelId: 'c1',
    guildId: 'g1',
    createdBy,
  });
}

describe('createSqliteReminderStore', () => {
  let db: DatabaseSync;
  let store: ReminderStore;

  beforeEach(() => {
    db = openAppDatabase(':memory:');
    store = createSqliteReminderStore(db);
  });

  it('未発火のものを期限の昇順で返す', () => {
    schedule(store, A, '2026-09-13T00:00:00.000Z', '後');
    schedule(store, A, '2026-09-12T00:00:00.000Z', '先');
    expect(store.listPending(A).map((r) => r.title)).toEqual(['先', '後']);
  });

  // 入れ物は全体でひとつだが、見えるのは自分の分だけ（→ D-35）。
  it('他の人が登録したものは見えない', () => {
    schedule(store, A, '2026-09-12T00:00:00.000Z');
    expect(store.listPending(B)).toHaveLength(0);
    expect(store.countPending(B)).toBe(0);
    expect(store.countPending(A)).toBe(1);
  });

  it('他の人が登録した ID は消せない', () => {
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

  // 届け先は登録したチャンネルで、誰が登録したかとは関係がない。
  it('登録者をまたいで期限が来たものをまとめて取る（poller は全体を見る）', () => {
    schedule(store, A, '2026-09-12T09:00:00.000Z');
    schedule(store, B, '2026-09-12T08:00:00.000Z');
    expect(store.claimDue('2026-09-12T10:00:00.000Z')).toHaveLength(2);
  });

  it('繰り返しは規則を往復させる', () => {
    const rule = createRecurrence({
      kind: 'weekly',
      weekdays: ['tue'],
      time: '09:00',
    });
    store.schedule({
      title: 'ゴミを出す',
      description: undefined,
      dueAt: '2026-09-15T00:00:00.000Z',
      recurrence: rule,
      channelId: 'c1',
      guildId: 'g1',
      createdBy: A,
    });
    expect(store.listPending(A)[0]?.recurrence).toEqual(rule);
  });

  it('繰り返しは消えず、次回へ進む（同じ回を二度取らない）', () => {
    const rule = createRecurrence({
      kind: 'weekly',
      weekdays: ['tue'],
      time: '09:00',
    });
    const reminder = store.schedule({
      title: 'ゴミを出す',
      description: undefined,
      dueAt: '2026-09-15T00:00:00.000Z',
      recurrence: rule,
      channelId: 'c1',
      guildId: 'g1',
      createdBy: A,
    });

    const now = '2026-09-15T00:00:30.000Z';
    const claimed = store.claimDue(now);
    expect(claimed).toHaveLength(1);
    // 返るのは「鳴った回」のスナップショット。
    expect(claimed[0]?.dueAt).toBe('2026-09-15T00:00:00.000Z');
    expect(claimed[0]?.firedAt).toBeUndefined();

    // 同じ tick で二度目は取れない。行は残り、次の火曜を向いている。
    expect(store.claimDue(now)).toHaveLength(0);
    const [pending] = store.listPending(A);
    expect(pending?.id).toBe(reminder.id);
    expect(pending?.dueAt).toBe('2026-09-22T00:00:00.000Z');
  });

  it('止まっていた間に過ぎた回は畳んで 1 回にする（→ D-29）', () => {
    store.schedule({
      title: '朝の確認',
      description: undefined,
      dueAt: '2026-09-12T00:00:00.000Z',
      recurrence: createRecurrence({ kind: 'daily', time: '09:00' }),
      channelId: 'c1',
      guildId: 'g1',
      createdBy: A,
    });

    // 3 日止まっていた。3 回ではなく 1 回だけ取れる。
    expect(store.claimDue('2026-09-15T02:00:00.000Z')).toHaveLength(1);
    expect(store.listPending(A)[0]?.dueAt).toBe('2026-09-16T00:00:00.000Z');
  });

  it('繰り返しも削除できる（止めるまで鳴り続けるため）', () => {
    const reminder = store.schedule({
      title: 'ゴミを出す',
      description: undefined,
      dueAt: '2026-09-15T00:00:00.000Z',
      recurrence: createRecurrence({
        kind: 'weekly',
        weekdays: ['tue'],
        time: '09:00',
      }),
      channelId: 'c1',
      guildId: 'g1',
      createdBy: A,
    });
    store.claimDue('2026-09-15T00:00:30.000Z');
    expect(store.cancel(A, reminder.id)).toBe(true);
    expect(store.listPending(A)).toHaveLength(0);
  });

  it('形の壊れた規則は読まずに落とす（黙って 1 回限りにしない）', () => {
    const reminder = store.schedule({
      title: 'ゴミを出す',
      description: undefined,
      dueAt: '2026-09-15T00:00:00.000Z',
      recurrence: createRecurrence({
        kind: 'weekly',
        weekdays: ['tue'],
        time: '09:00',
      }),
      channelId: 'c1',
      guildId: 'g1',
      createdBy: A,
    });
    db.exec(
      `UPDATE reminders SET recurrence = '{"kind":"weekly","time":"09:00"}'
        WHERE id = '${reminder.id}'`,
    );

    expect(() => store.listPending(A)).toThrow(/曜日がありません/);
  });

  it('補足は null と undefined を往復させる', () => {
    const withDescription = store.schedule({
      title: 'やること',
      description: 'くわしく',
      dueAt: '2026-09-12T09:00:00.000Z',
      recurrence: undefined,
      channelId: 'c1',
      guildId: undefined,
      createdBy: A,
    });
    const [stored] = store.listPending(A);
    expect(stored?.description).toBe('くわしく');
    expect(stored?.guildId).toBeUndefined();
    expect(stored?.id).toBe(withDescription.id);
  });

  // 登録者の分からない入口は今のところ無いが、列は NULL を許す。
  // その行は誰の一覧にも出ないまま、発火だけはする。
  it('登録者のない行は一覧に出ないが、発火はする', () => {
    store.schedule({
      title: 'やること',
      description: undefined,
      dueAt: '2026-09-12T09:00:00.000Z',
      recurrence: undefined,
      channelId: 'c1',
      guildId: 'g1',
      createdBy: undefined,
    });
    expect(store.listPending(A)).toHaveLength(0);
    const [claimed] = store.claimDue('2026-09-12T10:00:00.000Z');
    expect(claimed?.createdBy).toBeUndefined();
  });
});
