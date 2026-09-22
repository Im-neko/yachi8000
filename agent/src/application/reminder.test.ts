import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ReminderStore,
  ScheduleReminderInput,
} from '../domain/ports/reminder-store.ts';
import type { VoiceChannelRef } from '../domain/ports/voice-output.ts';
import {
  createRecurrence,
  nextOccurrence,
  type Reminder,
} from '../domain/reminder.ts';
import type { SpeakerId } from '../domain/speaker.ts';
import { hasNoTarget, selectSpeechTargets } from '../domain/speech-audience.ts';
import {
  cancelReminder,
  fireDueReminders,
  listReminders,
  type ReminderDeliveryDependencies,
  scheduleRecurringReminder,
  scheduleReminder,
} from './reminder.ts';

const SPEAKER = 'discord-user-1' as SpeakerId;
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
        title: input.title,
        description: input.description,
        dueAt: input.dueAt,
        recurrence: input.recurrence,
        channelId: input.channelId,
        guildId: input.guildId,
        createdBy: input.createdBy,
        createdAt: NOW.toISOString(),
        firedAt: undefined,
      };
      rows.push(reminder);
      return reminder;
    },

    listPending(createdBy) {
      return rows
        .filter(
          (row) => row.createdBy === createdBy && row.firedAt === undefined,
        )
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    },

    cancel(createdBy, id) {
      const index = rows.findIndex(
        (row) =>
          row.createdBy === createdBy &&
          row.id === id &&
          row.firedAt === undefined,
      );
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },

    countPending(createdBy) {
      return rows.filter(
        (row) => row.createdBy === createdBy && row.firedAt === undefined,
      ).length;
    },

    claimDue(now) {
      const claimed: Reminder[] = [];
      for (const [index, row] of rows.entries()) {
        if (row.firedAt !== undefined || row.dueAt > now) continue;
        if (row.recurrence === undefined) {
          const fired = { ...row, firedAt: now };
          rows[index] = fired;
          claimed.push(fired);
          continue;
        }
        // 繰り返しは消えず、次回へ進む（SQLite 実装と同じ契約）。
        rows[index] = {
          ...row,
          dueAt: nextOccurrence(row.recurrence, new Date(now)),
        };
        claimed.push(row);
      }
      return claimed.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    },
  };
}

interface Harness {
  deps: ReminderDeliveryDependencies;
  phrased: Array<{ reminder: Reminder; firedAt: Date }>;
  spoken: Array<{ text: string; priority: string }>;
  sent: Array<{ channelId: string; text: string }>;
  warnings: string[];
  errors: string[];
}

/** 既定の文面づくり。**定型文とは違う形**にして、どちらを通ったか見分ける。 */
async function phraseLikeAnAssistant(reminder: Reminder): Promise<string> {
  return `${reminder.title}、そろそろだよ。`;
}

function createHarness(options: {
  connectedTo?: VoiceChannelRef;
  /** 音を鳴らせると名乗っているブラウザの数（F-23, D-40）。 */
  listeningBrowsers?: number;
  send?: () => Promise<void>;
  phrase?: (reminder: Reminder, firedAt: Date) => Promise<string>;
}): Harness {
  const spoken: Array<{ text: string; priority: string }> = [];
  const sent: Array<{ channelId: string; text: string }> = [];
  const phrased: Array<{ reminder: Reminder; firedAt: Date }> = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  return {
    spoken,
    sent,
    phrased,
    warnings,
    errors,
    deps: {
      store: createFakeReminderStore(),
      phraser: {
        phrase: (reminder, firedAt) => {
          phrased.push({ reminder, firedAt });
          return (options.phrase ?? phraseLikeAnAssistant)(reminder, firedAt);
        },
      },
      speech: {
        speak: ({ text, priority }) => {
          spoken.push({ text, priority });
        },
        // 出口の選び方は domain の関数そのものを使う（→ D-40）。
        canSpeak: (origin) =>
          !hasNoTarget(
            selectSpeechTargets(origin, {
              voiceGuildId: options.connectedTo?.guildId,
              listeningBrowsers: options.listeningBrowsers ?? 0,
              presence: 'unknown',
            }),
          ),
        pending: () => 0,
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
        warn: (_context, message) => {
          warnings.push(message);
        },
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
    createdBy: SPEAKER,
    title: 'ゴミを出す',
    description: undefined,
    dueAtJst,
    channelId: overrides.channelId ?? 'c1',
    guildId: 'guildId' in overrides ? overrides.guildId : 'g1',
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
    expect(listReminders(harness.deps, SPEAKER)).toHaveLength(1);
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
        createdBy: SPEAKER,
        title: '   ',
        description: undefined,
        dueAtJst: '2026-09-12T10:00',
        channelId: 'c1',
        guildId: 'g1',
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
      createdBy: SPEAKER,
      title: 'やること',
      description: '   ',
      dueAtJst: '2026-09-12T10:00',
      channelId: 'c1',
      guildId: 'g1',
      now: NOW,
    });
    expect(reminder.description).toBeUndefined();
  });
});

function scheduleWeekly(harness: Harness, weekday: 'tue' = 'tue') {
  return scheduleRecurringReminder(harness.deps, {
    createdBy: SPEAKER,
    title: 'ゴミを出す',
    description: undefined,
    recurrence: createRecurrence({
      kind: 'weekly',
      weekdays: [weekday],
      time: '09:00',
    }),
    channelId: 'c1',
    guildId: 'g1',
    now: NOW,
  });
}

describe('scheduleRecurringReminder', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness({});
  });

  it('最初の回を規則から決める（過去判定が要らない）', () => {
    // NOW は 2026-09-12（土）09:00 JST。次の火曜は 9/15 の 09:00 JST。
    const reminder = scheduleWeekly(harness);
    expect(reminder.dueAt).toBe('2026-09-15T00:00:00.000Z');
    expect(reminder.recurrence).toEqual({
      kind: 'weekly',
      weekdays: ['tue'],
      time: '09:00',
    });
  });

  it('空の内容は拒む', () => {
    expect(() =>
      scheduleRecurringReminder(harness.deps, {
        createdBy: SPEAKER,
        title: '  ',
        description: undefined,
        recurrence: createRecurrence({ kind: 'daily', time: '09:00' }),
        channelId: 'c1',
        guildId: 'g1',
        now: NOW,
      }),
    ).toThrow(/内容が空/);
  });

  // 鳴っても消えないぶん、上限に効かせておかないと際限なく溜まる。
  it('1 回限りのものと同じ枠で数える', () => {
    for (let i = 0; i < 100; i++) schedule(harness, '2026-09-12T10:00');
    expect(() => scheduleWeekly(harness)).toThrow(/上限/);
  });
});

describe('cancelReminder', () => {
  it('消せたかどうかを返す', () => {
    const harness = createHarness({});
    const reminder = schedule(harness, '2026-09-12T10:00');
    expect(
      cancelReminder(harness.deps, { createdBy: SPEAKER, id: reminder.id }),
    ).toBe(true);
    expect(
      cancelReminder(harness.deps, { createdBy: SPEAKER, id: reminder.id }),
    ).toBe(false);
  });
});

describe('fireDueReminders（繰り返し）', () => {
  it('鳴っても消えず、次の回を向く', async () => {
    const harness = createHarness({});
    scheduleWeekly(harness);

    const fired = await fireDueReminders(
      harness.deps,
      new Date('2026-09-15T00:00:30.000Z'),
    );
    expect(fired).toBe(1);
    expect(harness.sent).toEqual([
      { channelId: 'c1', text: 'ゴミを出す、そろそろだよ。' },
    ]);

    const [pending] = listReminders(harness.deps, SPEAKER);
    expect(pending?.dueAt).toBe('2026-09-22T00:00:00.000Z');
  });

  it('止まっていた間に過ぎた回は畳み、畳んだことを WARN で残す（→ D-29, INV-7）', async () => {
    const harness = createHarness({});
    scheduleRecurringReminder(harness.deps, {
      createdBy: SPEAKER,
      title: '朝の確認',
      description: undefined,
      recurrence: createRecurrence({ kind: 'daily', time: '09:00' }),
      channelId: 'c1',
      guildId: 'g1',
      now: NOW,
    });

    // 3 日止まっていた。3 回ではなく 1 回だけ届く。
    expect(
      await fireDueReminders(
        harness.deps,
        new Date('2026-09-16T02:00:00.000Z'),
      ),
    ).toBe(1);
    expect(harness.sent).toHaveLength(1);
    expect(harness.warnings).toEqual([
      'Collapsed missed occurrences of a recurring reminder into a single delivery',
    ]);
  });

  it('遅れずに鳴ったときは WARN を出さない', async () => {
    const harness = createHarness({});
    scheduleWeekly(harness);
    await fireDueReminders(harness.deps, new Date('2026-09-15T00:00:30.000Z'));
    expect(harness.warnings).toEqual([]);
  });
});

describe('fireDueReminders', () => {
  it('期限が来ていなければ何もしない', async () => {
    const harness = createHarness({});
    schedule(harness, '2026-09-12T10:00');
    expect(await fireDueReminders(harness.deps, NOW)).toBe(0);
    expect(harness.sent).toHaveLength(0);
  });

  it('期限が来たら組み立てた文面を登録されたチャンネルへ流す（→ D-30）', async () => {
    const harness = createHarness({});
    schedule(harness, '2026-09-12T10:00', { channelId: 'target-channel' });

    const fired = await fireDueReminders(
      harness.deps,
      new Date('2026-09-12T01:00:00.000Z'),
    );
    expect(fired).toBe(1);
    expect(harness.sent).toEqual([
      { channelId: 'target-channel', text: 'ゴミを出す、そろそろだよ。' },
    ]);
  });

  it('保存したリマインダーと発火時刻を素材として渡す', async () => {
    const harness = createHarness({});
    schedule(harness, '2026-09-12T10:00');

    const firedAt = new Date('2026-09-12T01:00:00.000Z');
    await fireDueReminders(harness.deps, firedAt);
    expect(harness.phrased).toHaveLength(1);
    expect(harness.phrased[0]?.reminder.title).toBe('ゴミを出す');
    expect(harness.phrased[0]?.firedAt).toEqual(firedAt);
  });

  // 縮退したことはログにしか残らない。読み上げは流れて消える。
  it('文面づくりに失敗したら定型文へ縮退し、WARN を残す（→ INV-7）', async () => {
    const harness = createHarness({
      phrase: () => Promise.reject(new Error('LLM が落ちている')),
    });
    schedule(harness, '2026-09-12T10:00');

    expect(
      await fireDueReminders(
        harness.deps,
        new Date('2026-09-12T01:00:00.000Z'),
      ),
    ).toBe(1);
    expect(harness.sent).toEqual([
      { channelId: 'c1', text: 'リマインダーです。ゴミを出す' },
    ]);
    expect(harness.warnings).toEqual([
      'Failed to phrase the reminder — falling back to the deterministic template',
    ]);
  });

  it('同じサーバの VC にいるときだけ声にする', async () => {
    const harness = createHarness({
      connectedTo: { guildId: 'g1', channelId: 'vc' },
    });
    schedule(harness, '2026-09-12T10:00');

    await fireDueReminders(harness.deps, new Date('2026-09-12T01:00:00.000Z'));
    expect(harness.spoken).toEqual([
      { text: 'ゴミを出す、そろそろだよ。', priority: 'reminder' },
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
