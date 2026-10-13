import { describe, expect, it } from 'vitest';
import {
  type ChannelMessage,
  CONTEXT_MESSAGE_MAX_CHARS,
  CONTEXT_TOTAL_MAX_CHARS,
  renderChannelContext,
} from './channel-context.ts';

// 2026-10-12 14:04 UTC = 23:04 JST
const AT = Date.UTC(2026, 9, 12, 14, 4);

function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    authorName: 'alice',
    fromAssistant: false,
    fromBot: false,
    postedAt: AT,
    text: 'こんにちは',
    ...overrides,
  };
}

describe('renderChannelContext', () => {
  it('発言が無ければ undefined', () => {
    expect(renderChannelContext([])).toBeUndefined();
  });

  it('本文の無い発言は載せない', () => {
    expect(renderChannelContext([message({ text: '  ' })])).toBeUndefined();
  });

  it('時刻は JST、古い順に並べる', () => {
    const out = renderChannelContext([
      message({ text: 'one' }),
      message({ text: 'two', postedAt: AT + 60_000 }),
    ]);
    expect(out).toBe('[10-12 23:04] alice: one\n[10-12 23:05] alice: two');
  });

  it('自分の投稿と Bot の投稿は見分けがつく', () => {
    const out = renderChannelContext([
      message({ authorName: 'YCY', fromAssistant: true, fromBot: true }),
      message({ authorName: 'Alertmanager', fromBot: true }),
    ]);
    expect(out).toContain('あなた（自分の投稿）: こんにちは');
    expect(out).toContain('Alertmanager（Bot）: こんにちは');
  });

  it('長い発言は切り詰める', () => {
    const out = renderChannelContext([
      message({ text: 'a'.repeat(CONTEXT_MESSAGE_MAX_CHARS + 50) }),
    ]);
    expect(out).toContain('…（以下略）');
    expect(out?.length).toBeLessThan(CONTEXT_MESSAGE_MAX_CHARS + 100);
  });

  it('全体が長いときは新しい発言を残し、省略した件数を先頭に出す', () => {
    const each = CONTEXT_MESSAGE_MAX_CHARS;
    const count = Math.ceil(CONTEXT_TOTAL_MAX_CHARS / each) + 3;
    const messages = Array.from({ length: count }, (_, i) =>
      message({
        text: `${i}:${'x'.repeat(each - 10)}`,
        postedAt: AT + i * 1000,
      }),
    );
    const out = renderChannelContext(messages) ?? '';
    expect(out.startsWith('（これより古い')).toBe(true);
    expect(out).toContain(`${count - 1}:`);
    expect(out).not.toContain('\n0:');
  });

  it('1 件が上限を超えていても、最新の 1 件は必ず残す', () => {
    const out = renderChannelContext([message({ text: 'y'.repeat(5000) })]);
    expect(out).toContain('yyy');
  });
});
