import { describe, expect, it } from 'vitest';
import {
  composeReminderText,
  formatJstDateTime,
  parseJstDueAt,
  type Reminder,
} from './reminder.ts';
import type { TenantId } from './tenant.ts';

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'r1',
    tenantId: 'discord-guild-1' as TenantId,
    title: 'ゴミを出す',
    description: undefined,
    dueAt: '2026-09-12T01:00:00.000Z',
    channelId: 'c1',
    guildId: 'g1',
    createdBy: 'u1',
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
