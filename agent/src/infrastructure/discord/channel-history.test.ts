import { describe, expect, it, vi } from 'vitest';
import { createDiscordChannelHistory } from './channel-history.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('createDiscordChannelHistory', () => {
  it('発言を読み、自分の投稿・Bot・embed の本文を見分ける', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/users/@me')) return json({ id: 'bot-self' });
      return json([
        {
          id: '3',
          type: 0,
          timestamp: '2026-10-12T14:00:00.000Z',
          content: '',
          embeds: [
            {
              title: 'FIRING',
              description: 'KabuApiUnreachable',
              fields: [{ name: 'severity', value: 'critical' }],
            },
          ],
          author: { id: 'am', username: 'Alertmanager', bot: true },
        },
        {
          id: '2',
          type: 0,
          timestamp: '2026-10-12T13:00:00.000Z',
          content: '日次レビュー',
          author: {
            id: 'bot-self',
            username: 'yachi',
            global_name: 'YCY',
            bot: true,
          },
        },
        {
          id: '1',
          type: 7,
          timestamp: '2026-10-12T12:00:00.000Z',
          content: '',
          author: { id: 'u', username: 'user' },
        },
      ]);
    });
    const history = createDiscordChannelHistory({
      token: 't',
      fetchImpl: fetchImpl as typeof fetch,
    });

    const messages = await history.fetch({
      channelId: 'c',
      limit: 5,
      before: '9',
    });

    expect(messages.map((m) => m.id)).toEqual(['3', '2']);
    expect(messages[0]).toMatchObject({
      authorName: 'Alertmanager',
      fromAssistant: false,
      fromBot: true,
      text: 'FIRING\nKabuApiUnreachable\nseverity: critical',
    });
    expect(messages[1]).toMatchObject({
      authorName: 'YCY',
      fromAssistant: true,
    });
    const requested = fetchImpl.mock.calls.map(([u]) => String(u));
    expect(
      requested.some((u) =>
        u.includes('/channels/c/messages?limit=5&before=9'),
      ),
    ).toBe(true);
  });

  it('読めなかったら投げる', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/users/@me') ? json({ id: 'b' }) : json({}, 403),
    );
    const history = createDiscordChannelHistory({
      token: 't',
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(history.fetch({ channelId: 'c', limit: 5 })).rejects.toThrow(
      'HTTP 403',
    );
  });
});
