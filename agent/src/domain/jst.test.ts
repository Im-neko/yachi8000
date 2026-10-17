import { describe, expect, it } from 'vitest';
import { formatJstMoment, formatJstWindow } from './jst.ts';

describe('formatJstWindow', () => {
  it('同じ日なら日付は 1 回', () => {
    expect(
      formatJstWindow(
        new Date('2026-10-15T18:00:00Z'),
        new Date('2026-10-15T20:00:00Z'),
      ),
    ).toBe('10-16 03:00〜05:00（JST）');
  });

  it('日をまたぐなら両端に日付を付ける', () => {
    expect(
      formatJstWindow(
        new Date('2026-10-15T14:00:00Z'),
        new Date('2026-10-15T16:00:00Z'),
      ),
    ).toBe('10-15 23:00〜10-16 01:00（JST）');
  });
});

describe('formatJstMoment', () => {
  it('JST の月日と時刻にする', () => {
    expect(formatJstMoment(new Date('2026-10-15T18:10:00.000Z'))).toBe(
      '10-16 03:10（JST）',
    );
  });
});
