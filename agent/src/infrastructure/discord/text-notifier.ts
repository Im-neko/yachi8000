import type { Client } from 'discord.js';
import type { TextNotifier } from '../../domain/ports/text-notifier.ts';

/**
 * VC へ出せなかった通知をテキストチャンネルへ流す（F-15）。
 *
 * 送れなかった場合は例外を投げる。捨てたことは呼び出し側（application/notify.ts）
 * がログに残す。
 */
export function createDiscordTextNotifier(client: Client): TextNotifier {
  return {
    async send(channelId, text) {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isSendable()) {
        throw new Error(
          `チャンネル ${channelId} へ送信できません。settings.yaml の notification.fallbackChannelId と Bot の権限を確認してください。`,
        );
      }
      await channel.send(text);
    },
  };
}
