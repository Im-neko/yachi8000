import {
  APPROVE_EMOJI,
  type ApprovalPrompt,
  REJECT_EMOJI,
} from '../../domain/ports/approval-prompt.ts';

const API_BASE = 'https://discord.com/api/v10';

export interface DiscordApprovalPromptOptions {
  token: string;
  /** テスト用の差し替え口。既定は global の fetch。 */
  fetchImpl?: typeof fetch;
}

/**
 * 承認をその場で聞く（F-44）。**REST を直接叩く**（→ port のコメント）。
 */
export function createDiscordApprovalPrompt(
  options: DiscordApprovalPromptOptions,
): ApprovalPrompt {
  const doFetch = options.fetchImpl ?? fetch;
  const headers = {
    authorization: `Bot ${options.token}`,
    'content-type': 'application/json',
  };

  async function react(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const response = await doFetch(
      `${API_BASE}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method: 'PUT', headers: { authorization: `Bot ${options.token}` } },
    );
    if (!response.ok) {
      throw new Error(
        `リアクションを付けられませんでした（HTTP ${response.status}）。`,
      );
    }
  }

  return {
    async ask(channelId, text) {
      const response = await doFetch(
        `${API_BASE}/channels/${channelId}/messages`,
        {
          method: 'POST',
          headers,
          // **メンションを飛ばさない。** 候補の本文に @ が混ざっていても、
          // それで人を呼び出さない（本文は利用者の言葉から生成されている）。
          body: JSON.stringify({
            content: text,
            allowed_mentions: { parse: [] },
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          `承認の問いかけを投稿できませんでした（HTTP ${response.status}）。`,
        );
      }
      const body = (await response.json()) as { id?: unknown };
      if (typeof body.id !== 'string') {
        throw new Error(
          '承認の問いかけを投稿しましたが、メッセージ ID が返りませんでした。',
        );
      }

      // **印を先に付ける。** 何も付いていないと、何で答えるのか分からない。
      // 順番も見えるので、承認を先に置く。
      await react(channelId, body.id, APPROVE_EMOJI);
      await react(channelId, body.id, REJECT_EMOJI);
      return body.id;
    },

    async settle(channelId, messageId, text) {
      const response = await doFetch(
        `${API_BASE}/channels/${channelId}/messages/${messageId}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            content: text,
            allowed_mentions: { parse: [] },
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          `承認の問いかけを書き換えられませんでした（HTTP ${response.status}）。`,
        );
      }
    },
  };
}
