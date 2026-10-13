import { describe, expect, it } from 'vitest';
import type { ChannelMessage } from '../domain/channel-context.ts';
import type {
  ChannelHistory,
  ChannelHistoryQuery,
} from '../domain/ports/channel-history.ts';
import {
  HISTORY_MAX_LIMIT,
  HISTORY_MAX_SCAN,
  RECENT_CONTEXT_HOURS,
  recentChannelContext,
  searchChannelHistory,
} from './channel-history.ts';

const NOW = Date.UTC(2026, 9, 12, 14, 0);
const HOUR = 60 * 60 * 1000;

function msg(
  n: number,
  overrides: Partial<ChannelMessage> = {},
): ChannelMessage {
  return {
    id: String(n),
    authorName: 'alice',
    fromAssistant: false,
    fromBot: false,
    postedAt: NOW - (1000 - n) * 60_000,
    text: `message ${n}`,
    ...overrides,
  };
}

/** id が大きいほど新しい。`before` より小さい id を新しい順に返す。 */
function fakeHistory(all: ChannelMessage[]) {
  const calls: ChannelHistoryQuery[] = [];
  const history: ChannelHistory = {
    async fetch(query) {
      calls.push(query);
      return all
        .filter(
          (m) =>
            query.before === undefined || Number(m.id) < Number(query.before),
        )
        .sort((a, b) => Number(b.id) - Number(a.id))
        .slice(0, query.limit);
    },
  };
  return { history, calls };
}

describe('recentChannelContext', () => {
  it('直近数時間の発言だけを古い順に渡す', async () => {
    const old = msg(1, {
      postedAt: NOW - (RECENT_CONTEXT_HOURS + 1) * HOUR,
      text: 'old one',
    });
    const { history } = fakeHistory([
      old,
      msg(2, { postedAt: NOW - HOUR, text: 'first' }),
      msg(3, {
        postedAt: NOW - 60_000,
        text: 'second',
        fromAssistant: true,
        fromBot: true,
      }),
    ]);

    const out = await recentChannelContext(
      { history },
      { channelId: 'c', beforeMessageId: '4', now: NOW },
    );

    expect(out).not.toContain('old one');
    expect(out?.indexOf('first')).toBeLessThan(out?.indexOf('second') ?? 0);
    expect(out).toContain('あなた（自分の投稿）: second');
  });

  it('範囲に発言が無ければ undefined', async () => {
    const { history } = fakeHistory([msg(1, { postedAt: NOW - 10 * HOUR })]);
    expect(
      await recentChannelContext(
        { history },
        { channelId: 'c', beforeMessageId: '2', now: NOW },
      ),
    ).toBeUndefined();
  });

  it('読み取りに失敗したら投げる（黙って空にしない）', async () => {
    const history: ChannelHistory = {
      fetch: async () => {
        throw new Error('HTTP 403');
      },
    };
    await expect(
      recentChannelContext(
        { history },
        { channelId: 'c', beforeMessageId: '2', now: NOW },
      ),
    ).rejects.toThrow('HTTP 403');
  });
});

describe('searchChannelHistory', () => {
  const all = Array.from({ length: 50 }, (_, i) => msg(i + 1));

  it('絞り込み無しは最新から limit 件を、古い順に返す', async () => {
    const result = await searchChannelHistory(
      { history: fakeHistory(all).history },
      { channelId: 'c', limit: 3 },
    );
    expect(result.messages.map((m) => m.id)).toEqual(['48', '49', '50']);
    expect(result.nextBefore).toBe('48');
  });

  it('before を渡すとその前から続けて読める', async () => {
    const result = await searchChannelHistory(
      { history: fakeHistory(all).history },
      { channelId: 'c', limit: 3, before: '48' },
    );
    expect(result.messages.map((m) => m.id)).toEqual(['45', '46', '47']);
  });

  it('limit は上限で切る', async () => {
    const { history, calls } = fakeHistory(all);
    const result = await searchChannelHistory(
      { history },
      { channelId: 'c', limit: 999 },
    );
    expect(result.messages).toHaveLength(HISTORY_MAX_LIMIT);
    expect(calls[0]?.limit).toBe(HISTORY_MAX_LIMIT);
  });

  it('contains は大文字小文字を区別せず、走査して一致するものだけ返す', async () => {
    const withNeedle = all.map((m) =>
      m.id === '7' ? { ...m, text: 'The 5XX ratio is high' } : m,
    );
    const result = await searchChannelHistory(
      { history: fakeHistory(withNeedle).history },
      { channelId: 'c', contains: '5xx' },
    );
    expect(result.messages.map((m) => m.id)).toEqual(['7']);
    expect(result.scanned).toBe(50);
    expect(result.nextBefore).toBeUndefined();
  });

  it('走査の上限に達したら、続きの起点を返す', async () => {
    const many = Array.from({ length: HISTORY_MAX_SCAN + 100 }, (_, i) =>
      msg(i + 1),
    );
    const result = await searchChannelHistory(
      { history: fakeHistory(many).history },
      { channelId: 'c', contains: 'no such text' },
    );
    expect(result.messages).toEqual([]);
    expect(result.scanned).toBe(HISTORY_MAX_SCAN);
    expect(result.nextBefore).toBe(String(many.length - HISTORY_MAX_SCAN + 1));
  });
});
