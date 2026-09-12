import type { Client } from 'discord.js';
import type { TextNotifier } from '../../domain/ports/text-notifier.ts';

/**
 * テキストチャンネルへの配信（F-15, F-31）。
 *
 * 送れなかった場合は例外を投げる。捨てたこと・落としたことは呼び出し側
 * （application/notify.ts, application/reminder.ts）がログに残す ——
 * 宛先をどう決めたかは呼び出し側しか知らないので、文脈はそちらで付ける。
 */
export function createDiscordTextNotifier(client: Client): TextNotifier {
  return {
    async send(channelId, text) {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isSendable()) {
        throw new Error(
          `チャンネル ${channelId} へ送信できません。チャンネルが存在するか、Bot に送信権限があるかを確認してください。`,
        );
      }
      await channel.send(text);
    },
  };
}
