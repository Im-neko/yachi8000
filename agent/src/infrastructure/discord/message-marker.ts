import type { MessageMarker } from '../../domain/ports/message-marker.ts';

/** U+2705。stocktrade の memo-triage が読み飛ばしの印に使っているものと同じ。 */
const HANDLED_EMOJI = encodeURIComponent('✅');

const API_BASE = 'https://discord.com/api/v10';

export interface DiscordMessageMarkerOptions {
  token: string;
  /** テスト用の差し替え口。既定は global の fetch。 */
  fetchImpl?: typeof fetch;
}

/**
 * 処理済みの印（F-37）を Discord のリアクションとして残す。
 *
 * **discord.js の Client ではなく REST を直接叩く。** ツールは合成ルートの
 * モジュール変数から依存を取るが、Client は Gateway が ready になってから
 * しか作れない（`createVoiceRuntime`）。印を付けるだけのためにツールへ
 * Client を配るより、トークン 1 本で完結する REST の方が配線が短い。
 *
 * 付けられなければ投げる。印が付かなかったことをどう扱うかは呼び出し側
 * （application/issue.ts）が決める —— Issue は既に立っているので、
 * そこで会話を止める話ではない。
 */
export function createDiscordMessageMarker(
  options: DiscordMessageMarkerOptions,
): MessageMarker {
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async markHandled(channelId, messageId) {
      const response = await doFetch(
        `${API_BASE}/channels/${channelId}/messages/${messageId}/reactions/${HANDLED_EMOJI}/@me`,
        {
          method: 'PUT',
          headers: { authorization: `Bot ${options.token}` },
        },
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `投稿 ${messageId} に印を付けられませんでした（${response.status}）: ${body.slice(0, 200)}`,
        );
      }
    },
  };
}
