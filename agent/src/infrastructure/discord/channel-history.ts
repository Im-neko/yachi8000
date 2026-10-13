import type { ChannelMessage } from '../../domain/channel-context.ts';
import type { ChannelHistory } from '../../domain/ports/channel-history.ts';

const API_BASE = 'https://discord.com/api/v10';
const MAX_LIMIT = 100;

interface DiscordEmbed {
  title?: string | null;
  description?: string | null;
  fields?: Array<{ name: string; value: string }>;
}

interface DiscordMessage {
  id: string;
  /** 0 = 通常、19 = 返信。それ以外（参加・ピン留めなど）は発言ではない。 */
  type: number;
  timestamp: string;
  content: string;
  embeds?: DiscordEmbed[];
  author: {
    id: string;
    username: string;
    global_name?: string | null;
    bot?: boolean;
  };
}

export interface DiscordChannelHistoryOptions {
  token: string;
  /** テスト用の差し替え口。既定は global の fetch。 */
  fetchImpl?: typeof fetch;
}

/** 本文と、embed の見出し・説明・項目（Alertmanager などはこちらに書く）。 */
function textOf(message: DiscordMessage): string {
  const embeds = (message.embeds ?? []).map((embed) =>
    [
      embed.title,
      embed.description,
      ...(embed.fields ?? []).map((f) => `${f.name}: ${f.value}`),
    ]
      .filter((part): part is string => !!part)
      .join('\n'),
  );
  return [message.content, ...embeds].filter((part) => part !== '').join('\n');
}

/**
 * チャンネルの発言を REST で読む（D-50）。**Client を持たない側（エージェントの
 * 道具）からも読めるように REST を直接叩く**（承認の問い合わせと同じ理由）。
 *
 * 本文は `MESSAGE_CONTENT`（特権インテント）が無いと空で返る。
 */
export function createDiscordChannelHistory(
  options: DiscordChannelHistoryOptions,
): ChannelHistory {
  const doFetch = options.fetchImpl ?? fetch;
  const headers = { authorization: `Bot ${options.token}` };

  // 自分（アシスタント）の投稿を見分けるための Bot のユーザー ID。トークンから
  // 引いて覚えておく。失敗したら覚えず、次の呼び出しでやり直す。
  let selfId: Promise<string> | undefined;
  function botUserId(): Promise<string> {
    selfId ??= (async () => {
      const response = await doFetch(`${API_BASE}/users/@me`, { headers });
      if (!response.ok) {
        throw new Error(
          `Bot 自身の情報を読めませんでした（HTTP ${response.status}）。`,
        );
      }
      return ((await response.json()) as { id: string }).id;
    })().catch((error) => {
      selfId = undefined;
      throw error;
    });
    return selfId;
  }

  return {
    async fetch({ channelId, limit, before }) {
      const params = new URLSearchParams({
        limit: String(Math.min(limit, MAX_LIMIT)),
      });
      if (before) params.set('before', before);
      const response = await doFetch(
        `${API_BASE}/channels/${channelId}/messages?${params}`,
        { headers },
      );
      if (!response.ok) {
        throw new Error(
          `チャンネルの発言を読めませんでした（HTTP ${response.status}）。Bot に「メッセージ履歴を読む」権限があるかを確認してください。`,
        );
      }
      const body = (await response.json()) as DiscordMessage[];
      const botId = await botUserId();
      return body
        .filter((m) => m.type === 0 || m.type === 19)
        .map(
          (m): ChannelMessage => ({
            id: m.id,
            authorName: m.author.global_name ?? m.author.username,
            fromAssistant: m.author.id === botId,
            fromBot: m.author.bot === true,
            postedAt: Date.parse(m.timestamp),
            text: textOf(m),
          }),
        );
    },
  };
}
