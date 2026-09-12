import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ReminderStore,
  ScheduleReminderInput,
} from '../domain/ports/reminder-store.ts';
import type { VoiceChannelRef } from '../domain/ports/voice-output.ts';
import type { Reminder } from '../domain/reminder.ts';
import type { TenantId } from '../domain/tenant.ts';
import {
  cancelReminder,
  fireDueReminders,
  listReminders,
  type ReminderDeliveryDependencies,
  scheduleReminder,
} from './reminder.ts';

const TENANT = 'discord-guild-1' as TenantId;
const NOW = new Date('2026-09-12T00:00:00.000Z'); // 09:00 JST

/**
 * ReminderStore の代役。
 *
 * ユースケースは port 越しにしか保存先を触らないので、ここでは SQL を
 * 通さない。**SQL 側の契約（claim の一度きり・テナント分離）は
 * `infrastructure/reminder/sqlite-reminder-store.test.ts` が受け持つ。**
 * ここで確かめるのは「印が立った行を二度配信しない」というユースケースの
 * 振る舞い。
 */
function createFakeReminderStore(): ReminderStore {
  const rows: Reminder[] = [];
  let nextId = 0;

  return {
    schedule(input: ScheduleReminderInput): Reminder {
      const reminder: Reminder = {
        id: `r${++nextId}`,
        tenantId: input.tenantId,
        title: input.title,
        description: input.description,
        dueAt: input.dueAt,
        channelId: input.channelId,
        guildId: input.guildId,
        createdBy: input.createdBy,
        createdAt: NOW.toISOString(),
        firedAt: undefined,
      };
      rows.push(reminder);
      return reminder;
    },

    listPending(tenantId) {
      return rows
        .filter((row) => row.tenantId === tenantId && row.firedAt === undefined)
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    },

    cancel(tenantId, id) {
      const index = rows.findIndex(
        (row) =>
          row.tenantId === tenantId &&
          row.id === id &&
          row.firedAt === undefined,
      );
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },

    claimDue(now) {
      const claimed: Reminder[] = [];
      for (const [index, row] of rows.entries()) {
        if (row.firedAt !== undefined || row.dueAt > now) continue;
        const fired = { ...row, firedAt: now };
        rows[index] = fired;
        claimed.push(fired);
      }
      return claimed.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    },
  };
}

interface Harness {
  deps: ReminderDeliveryDependencies;
  spoken: Array<{ text: string; priority: string }>;
  sent: Array<{ channelId: string; text: string }>;
  errors: string[];
}

function createHarness(options: {
  connectedTo?: VoiceChannelRef;
  send?: () => Promise<void>;
}): Harness {
  const spoken: Array<{ text: string; priority: string }> = [];
  const sent: Array<{ channelId: string; text: string }> = [];
  const errors: string[] = [];

  return {
    spoken,
    sent,
    errors,
    deps: {
      store: createFakeReminderStore(),
      speech: {
        speak: ({ text, priority }) => {
          spoken.push({ text, priority });
        },
        pending: () => 0,
      },
      voice: {
        join: async () => undefined,
        leave: () => false,
        current: () => options.connectedTo,
        play: async () => undefined,
      },
      text: {
        send:
          options.send ??
          (async (channelId, text) => {
            sent.push({ channelId, text });
          }),
      },
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: (_context, message) => {
          errors.push(message);
        },
      },
    },
  };
}

function schedule(
  harness: Harness,
  dueAtJst: string,
  overrides: { guildId?: string | undefined; channelId?: string } = {},
) {
  return scheduleReminder(harness.deps, {
    tenantId: TENANT,
    title: 'ゴミを出す',
    description: undefined,
    dueAtJst,
    channelId: overrides.channelId ?? 'c1',
    guildId: 'guildId' in overrides ? overrides.guildId : 'g1',
    createdBy: 'u1',
    now: NOW,
  });
}

describe('scheduleReminder', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness({});
  });

  it('未来の日時なら登録できる', () => {
    const reminder = schedule(harness, '2026-09-12T10:00');
    expect(reminder.dueAt).toBe('2026-09-12T01:00:00.000Z');
    expect(listReminders(harness.deps, TENANT)).toHaveLength(1);
  });

  // 「登録できたのに鳴らない」が最も分かりにくい壊れ方。poller は未来しか
  // 見ないので、過去を受けると黙って消える。
  it('過去の日時は拒む', () => {
    expect(() => schedule(harness, '2026-09-12T08:00')).toThrow(/過去の時刻/);
    expect(() => schedule(harness, '2026-09-12T09:00')).toThrow(/過去の時刻/);
  });

  it('空の内容は拒む', () => {
    expect(() =>
      scheduleReminder(harness.deps, {
        tenantId: TENANT,
        title: '   ',
        description: undefined,
        dueAtJst: '2026-09-12T10:00',
        channelId: 'c1',
        guildId: 'g1',
        createdBy: 'u1',
        now: NOW,
      }),
    ).toThrow(/内容が空/);
  });

  it('溜まりすぎたら断る', () => {
    for (let i = 0; i < 100; i++) schedule(harness, '2026-09-12T10:00');
    expect(() => schedule(harness, '2026-09-12T10:00')).toThrow(/上限/);
  });

  it('空白だけの補足は落とす', () => {
    const reminder = scheduleReminder(harness.deps, {
      tenantId: TENANT,
      title: 'やること',
      description: '   ',
      dueAtJst: '2026-09-12T10:00',
      channelId: 'c1',
      guildId: 'g1',
      createdBy: 'u1',
      now: NOW,
    });
    expect(reminder.description).toBeUndefined();
  });
});

describe('cancelReminder', () => {
  it('消せたかどうかを返す', () => {
    const harness = createHarness({});
    const reminder = schedule(harness, '2026-09-12T10:00');
    expect(
      cancelReminder(harness.deps, { tenantId: TENANT, id: reminder.id }),
    ).toBe(true);
    expect(
      cancelReminder(harness.deps, { tenantId: TENANT, id: reminder.id }),
    ).toBe(false);
  });
});

describe('fireDueReminders', () => {
  it('期限が来ていなければ何もしない', async () => {
    const harness = createHarness({});
    schedule(harness, '2026-09-12T10:00');
    expect(await fireDueReminders(harness.deps, NOW)).toBe(0);
    expect(harness.sent).toHaveLength(0);
  });

  it('期限が来たら登録されたチャンネルへ保存した文面のまま流す（D-08）', async () => {
    const harness = createHarness({});
    schedule(harness, '2026-09-12T10:00', { channelId: 'target-channel' });

    const fired = await fireDueReminders(
      harness.deps,
      new Date('2026-09-12T01:00:00.000Z'),
    );
    expect(fired).toBe(1);
    expect(harness.sent).toEqual([
      { channelId: 'target-channel', text: 'リマインダーです。ゴミを出す' },
    ]);
  });

  it('同じサーバの VC にいるときだけ声にする', async () => {
    const harness = createHarness({
      connectedTo: { guildId: 'g1', channelId: 'vc' },
    });
    schedule(harness, '2026-09-12T10:00');

    await fireDueReminders(harness.deps, new Date('2026-09-12T01:00:00.000Z'));
    expect(harness.spoken).toEqual([
      { text: 'リマインダーです。ゴミを出す', priority: 'reminder' },
    ]);
  });

  it('別のサーバの VC にいるなら読み上げない', async () => {
    const harness = createHarness({
      connectedTo: { guildId: 'other', channelId: 'vc' },
    });
    schedule(harness, '2026-09-12T10:00');

    await fireDueReminders(harness.deps, new Date('2026-09-12T01:00:00.000Z'));
    expect(harness.spoken).toHaveLength(0);
    expect(harness.sent).toHaveLength(1);
  });

  it('DM のリマインダーは VC で読み上げない', async () => {
    const harness = createHarness({
      connectedTo: { guildId: 'g1', channelId: 'vc' },
    });
    schedule(harness, '2026-09-12T10:00', { guildId: undefined });

    await fireDueReminders(harness.deps, new Date('2026-09-12T01:00:00.000Z'));
    expect(harness.spoken).toHaveLength(0);
    expect(harness.sent).toHaveLength(1);
  });

  it('一度発火したものは二度発火しない', async () => {
    const harness = createHarness({});
    schedule(harness, '2026-09-12T10:00');

    const later = new Date('2026-09-12T02:00:00.000Z');
    expect(await fireDueReminders(harness.deps, later)).toBe(1);
    expect(await fireDueReminders(harness.deps, later)).toBe(0);
    expect(harness.sent).toHaveLength(1);
  });

  it('止まっていた間に期限が過ぎたものは、次の確認でまとめて出す', async () => {
    const harness = createHarness({});
    schedule(harness, '2026-09-12T10:00');
    schedule(harness, '2026-09-12T11:00');

    expect(
      await fireDueReminders(
        harness.deps,
        new Date('2026-09-12T05:00:00.000Z'),
      ),
    ).toBe(2);
  });

  it('配信に失敗しても再送しない（二重読み上げより取り落としを選ぶ）', async () => {
    const harness = createHarness({
      send: async () => {
        throw new Error('チャンネルへ送れません');
      },
    });
    schedule(harness, '2026-09-12T10:00');

    const later = new Date('2026-09-12T02:00:00.000Z');
    await fireDueReminders(harness.deps, later);
    expect(harness.errors).toHaveLength(1);
    // 印は既に立っているので、次の確認では拾われない。
    expect(await fireDueReminders(harness.deps, later)).toBe(0);
  });

  it('1 件の配信失敗で残りを止めない', async () => {
    let calls = 0;
    const sent: string[] = [];
    const harness = createHarness({
      send: async () => {
        calls += 1;
        if (calls === 1) throw new Error('1 件目だけ失敗');
        sent.push('ok');
      },
    });
    schedule(harness, '2026-09-12T10:00');
    schedule(harness, '2026-09-12T11:00');

    await fireDueReminders(harness.deps, new Date('2026-09-12T05:00:00.000Z'));
    expect(calls).toBe(2);
    expect(sent).toHaveLength(1);
    expect(harness.errors).toHaveLength(1);
  });
});
