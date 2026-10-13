import { describe, expect, it } from 'vitest';
import { ConversationWindow } from './conversation-window.ts';

const MINUTE = 60_000;

describe('ConversationWindow', () => {
  it('開く前は閉じている', () => {
    const window = new ConversationWindow(10 * MINUTE);
    expect(window.isOpen('c1', 'u1', 0)).toBe(false);
  });

  it('開いてから期間のあいだは続けて応答できる', () => {
    const window = new ConversationWindow(10 * MINUTE);
    window.open('c1', 'u1', 0);
    expect(window.isOpen('c1', 'u1', 9 * MINUTE)).toBe(true);
  });

  it('期間を過ぎると閉じる（ちょうどの時刻も閉じる）', () => {
    const window = new ConversationWindow(10 * MINUTE);
    window.open('c1', 'u1', 0);
    expect(window.isOpen('c1', 'u1', 10 * MINUTE)).toBe(false);
  });

  it('返信のたびに開き直して延びる', () => {
    const window = new ConversationWindow(10 * MINUTE);
    window.open('c1', 'u1', 0);
    window.open('c1', 'u1', 8 * MINUTE);
    expect(window.isOpen('c1', 'u1', 15 * MINUTE)).toBe(true);
  });

  it('相手とチャンネルの組ごとに別々に開く', () => {
    const window = new ConversationWindow(10 * MINUTE);
    window.open('c1', 'u1', 0);
    expect(window.isOpen('c1', 'u2', MINUTE)).toBe(false);
    expect(window.isOpen('c2', 'u1', MINUTE)).toBe(false);
  });

  it('閉じた窓を掃除しても、開いている窓は残る', () => {
    const window = new ConversationWindow(10 * MINUTE);
    window.open('c1', 'u1', 0);
    window.open('c2', 'u2', 11 * MINUTE);
    expect(window.isOpen('c1', 'u1', 11 * MINUTE)).toBe(false);
    expect(window.isOpen('c2', 'u2', 12 * MINUTE)).toBe(true);
  });
});
