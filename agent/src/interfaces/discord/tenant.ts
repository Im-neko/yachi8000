import type { Message } from 'discord.js';
import {
  discordDirectMessageTenantId,
  discordGuildTenantId,
  type TenantId,
} from '../../domain/tenant.ts';

/**
 * このメッセージが属するテナント（F-04）。
 *
 * サーバ内は全チャンネルで 1 テナント、DM は相手ごとに 1 テナント。
 * チャンネル単位にしないのは、同じサーバで交わした話を別チャンネルでも
 * 覚えていてほしいため。
 */
export function tenantIdOf(message: Message): TenantId {
  return message.inGuild()
    ? discordGuildTenantId(message.guildId)
    : discordDirectMessageTenantId(message.author.id);
}
