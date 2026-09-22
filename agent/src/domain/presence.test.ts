import { describe, expect, it } from 'vitest';
import {
  aggregatePresence,
  PRESENCE_TTL_MS,
  type PresenceReport,
  renderPresence,
} from './presence.ts';

const NOW = 1_000_000;

function at(offsetMs: number, state: PresenceReport['state']): PresenceReport {
  return { state, at: NOW - offsetMs };
}

describe('aggregatePresence', () => {
  it('報告が無ければ「分からない」', () => {
    expect(aggregatePresence([], NOW)).toBe('unknown');
  });

  it('誰か 1 人でもいれば「いる」', () => {
    // 端末が 2 つあって片方に人がいないだけ、で読み上げを止める理由は無い。
    expect(aggregatePresence([at(0, 'absent'), at(0, 'present')], NOW)).toBe(
      'present',
    );
  });

  it('全員「いない」なら「いない」', () => {
    expect(aggregatePresence([at(0, 'absent'), at(0, 'absent')], NOW)).toBe(
      'absent',
    );
  });

  it('「分からない」は「いない」にしない', () => {
    // 潰すと、カメラを切っただけで読み上げが止まる（→ D-46 の 2）。
    expect(aggregatePresence([at(0, 'unknown')], NOW)).toBe('unknown');
  });

  it('古い報告は数えない', () => {
    // 閉じたタブの「いる」が残り続けないように。
    expect(aggregatePresence([at(PRESENCE_TTL_MS + 1, 'present')], NOW)).toBe(
      'unknown',
    );
  });

  it('古い「いない」も数えない', () => {
    expect(aggregatePresence([at(PRESENCE_TTL_MS + 1, 'absent')], NOW)).toBe(
      'unknown',
    );
  });
});

describe('renderPresence', () => {
  it('「分からない」ときは何も言わない', () => {
    // 書くと、カメラを使っていない人との会話に毎回「分かりません」が混ざる。
    expect(renderPresence('unknown')).toBe('');
  });

  it('いるときといないときは伝える', () => {
    expect(renderPresence('present')).toContain('います');
    expect(renderPresence('absent')).toContain('いません');
  });
});
