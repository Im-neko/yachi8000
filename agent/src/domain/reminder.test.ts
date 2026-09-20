import { describe, expect, it } from 'vitest';
import {
  composeReminderText,
  createRecurrence,
  describeRecurrence,
  formatJstDateTime,
  nextOccurrence,
  parseJstDueAt,
  type Reminder,
} from './reminder.ts';
import type { SpeakerId } from './speaker.ts';

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'r1',
    title: 'ゴミを出す',
    description: undefined,
    dueAt: '2026-09-12T01:00:00.000Z',
    recurrence: undefined,
    channelId: 'c1',
    guildId: 'g1',
    createdBy: 'discord-user-1' as SpeakerId,
    createdAt: '2026-09-12T00:00:00.000Z',
    firedAt: undefined,
    ...overrides,
  };
}

describe('parseJstDueAt', () => {
  it('JST として解釈して UTC に直す', () => {
    // 09:00 JST は同日 00:00 UTC。
    expect(parseJstDueAt('2026-09-12T09:00')).toBe('2026-09-12T00:00:00.000Z');
  });

  it('日付をまたぐ変換も合う', () => {
    expect(parseJstDueAt('2026-09-12T08:30')).toBe('2026-09-11T23:30:00.000Z');
  });

  it('前後の空白は許す', () => {
    expect(parseJstDueAt('  2026-09-12T09:00  ')).toBe(
      '2026-09-12T00:00:00.000Z',
    );
  });

  it('形式が違えば落ちる', () => {
    expect(() => parseJstDueAt('2026/09/12 09:00')).toThrow(/形式が違います/);
    expect(() => parseJstDueAt('2026-09-12T09:00:00')).toThrow(
      /形式が違います/,
    );
    expect(() => parseJstDueAt('明日の朝')).toThrow(/形式が違います/);
  });

  it('存在しない日付を黙って繰り上げない', () => {
    // Date は 2026-02-31 を 3/3 に繰り上げる（NaN にはならない）。そのまま
    // 通すと、登録した日時と鳴る日時が違う状態になる。
    expect(() => parseJstDueAt('2026-02-31T09:00')).toThrow(/存在しない日時/);
    expect(() => parseJstDueAt('2026-11-31T09:00')).toThrow(/存在しない日時/);
  });

  it('範囲外の月・時刻も通さない', () => {
    // こちらは Date 自体が Invalid Date になる。
    expect(() => parseJstDueAt('2026-13-01T09:00')).toThrow(/解釈できません/);
    expect(() => parseJstDueAt('2026-09-12T25:00')).toThrow(/解釈できません/);
  });
});

describe('formatJstDateTime', () => {
  it('parseJstDueAt と往復する', () => {
    const iso = parseJstDueAt('2026-12-31T23:59');
    expect(formatJstDateTime(new Date(iso))).toBe('2026-12-31T23:59');
  });
});

describe('composeReminderText', () => {
  it('保存した文言をそのまま並べる（言い換えない。D-08）', () => {
    expect(composeReminderText(reminder())).toBe(
      'リマインダーです。ゴミを出す',
    );
  });

  it('補足があれば改行して続ける', () => {
    expect(
      composeReminderText(reminder({ description: '燃えるゴミの日' })),
    ).toBe('リマインダーです。ゴミを出す\n燃えるゴミの日');
  });

  it('空白だけの補足は落とす', () => {
    expect(composeReminderText(reminder({ description: '   ' }))).toBe(
      'リマインダーです。ゴミを出す',
    );
  });
});

describe('createRecurrence', () => {
  it('毎週は曜日を日曜起点に並べ替え、重複を潰す', () => {
    const rule = createRecurrence({
      kind: 'weekly',
      weekdays: ['fri', 'mon', 'mon'],
      time: '09:00',
    });
    expect(rule).toEqual({
      kind: 'weekly',
      weekdays: ['mon', 'fri'],
      time: '09:00',
    });
  });

  it('毎日は曜日を持たない', () => {
    expect(createRecurrence({ kind: 'daily', time: '07:30' })).toEqual({
      kind: 'daily',
      time: '07:30',
    });
  });

  it('曜日の無い毎週は拒む（鳴らない規則を保存しない）', () => {
    expect(() => createRecurrence({ kind: 'weekly', time: '09:00' })).toThrow(
      /曜日を 1 つ以上/,
    );
    expect(() =>
      createRecurrence({ kind: 'weekly', weekdays: [], time: '09:00' }),
    ).toThrow(/曜日を 1 つ以上/);
  });

  it('知らない曜日は拒む', () => {
    expect(() =>
      createRecurrence({ kind: 'weekly', weekdays: ['火'], time: '09:00' }),
    ).toThrow(/曜日として解釈できません/);
  });

  it('時刻の形式と範囲を見る', () => {
    expect(() => createRecurrence({ kind: 'daily', time: '9:00' })).toThrow(
      /形式が違います/,
    );
    expect(() => createRecurrence({ kind: 'daily', time: '25:00' })).toThrow(
      /存在しない時刻/,
    );
    expect(() => createRecurrence({ kind: 'daily', time: '09:60' })).toThrow(
      /存在しない時刻/,
    );
  });
});

describe('nextOccurrence', () => {
  const weeklyTuesday = createRecurrence({
    kind: 'weekly',
    weekdays: ['tue'],
    time: '09:00',
  });

  it('毎日は同じ日のまだ来ていない回を、無ければ翌日を返す', () => {
    // 基準は 2026-09-12T00:00Z = 09:00 JST。同じ日の 10:00 はまだ先だが、
    // 08:00 は過ぎているので翌日へ回る。
    expect(
      nextOccurrence(
        createRecurrence({ kind: 'daily', time: '10:00' }),
        new Date('2026-09-12T00:00:00.000Z'),
      ),
    ).toBe('2026-09-12T01:00:00.000Z');
    expect(
      nextOccurrence(
        createRecurrence({ kind: 'daily', time: '08:00' }),
        new Date('2026-09-12T00:00:00.000Z'),
      ),
    ).toBe('2026-09-12T23:00:00.000Z');
  });

  it('ちょうどその時刻は次回に数えない（発火直後に同じ回を二度鳴らさない）', () => {
    // 2026-09-15T00:00Z は火曜 09:00 JST。
    expect(
      nextOccurrence(weeklyTuesday, new Date('2026-09-15T00:00:00.000Z')),
    ).toBe('2026-09-22T00:00:00.000Z');
  });

  it('毎週は次に当たる曜日まで飛ぶ', () => {
    // 水曜（2026-09-16）に数えると、次の火曜は 9/22。
    expect(
      nextOccurrence(weeklyTuesday, new Date('2026-09-16T03:00:00.000Z')),
    ).toBe('2026-09-22T00:00:00.000Z');
  });

  it('複数の曜日は一番近いものを取る', () => {
    const rule = createRecurrence({
      kind: 'weekly',
      weekdays: ['tue', 'fri'],
      time: '09:00',
    });
    // 水曜に数えると金曜（2026-09-18）。
    expect(nextOccurrence(rule, new Date('2026-09-16T03:00:00.000Z'))).toBe(
      '2026-09-18T00:00:00.000Z',
    );
  });

  it('JST の日付が UTC と食い違う時刻でも曜日を取り違えない', () => {
    // 00:30 JST は前日 15:30 UTC。UTC の曜日で数えると月曜になる。
    const rule = createRecurrence({
      kind: 'weekly',
      weekdays: ['tue'],
      time: '00:30',
    });
    const next = nextOccurrence(rule, new Date('2026-09-13T00:00:00.000Z'));
    expect(next).toBe('2026-09-14T15:30:00.000Z');
    expect(formatJstDateTime(new Date(next))).toBe('2026-09-15T00:30');
  });

  it('ずっと前を基準にしても、その直後の回を返す', () => {
    // 止まっていた間に過ぎた回を数えるのに使う（→ D-29）。
    expect(
      nextOccurrence(
        createRecurrence({ kind: 'daily', time: '09:00' }),
        new Date('2026-09-01T00:00:00.000Z'),
      ),
    ).toBe('2026-09-02T00:00:00.000Z');
  });
});

describe('describeRecurrence', () => {
  it('毎日と毎週を日本語で並べる', () => {
    expect(
      describeRecurrence(createRecurrence({ kind: 'daily', time: '07:30' })),
    ).toBe('毎日 07:30');
    expect(
      describeRecurrence(
        createRecurrence({
          kind: 'weekly',
          weekdays: ['mon', 'wed', 'fri'],
          time: '09:00',
        }),
      ),
    ).toBe('毎週月・水・金曜 09:00');
  });
});
