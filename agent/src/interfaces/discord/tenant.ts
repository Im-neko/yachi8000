import type { Interaction, Message } from 'discord.js';
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

/**
 * スラッシュコマンドが対象とするテナント（F-04）。
 *
 * **ギルド内でしか決まらない。** コマンドはギルド単位で登録するので DM には
 * 生えず、ギルドで実行したコマンドが指すのは**そのギルドのテナント**。
 * つまり **DM テナントのスキル・人格差分には、今どこからも手が届かない**
 * （→ D-26 の既知の穴、Q-24）。
 */
export function tenantIdOfInteraction(
  interaction: Interaction,
): TenantId | undefined {
  return interaction.inGuild()
    ? discordGuildTenantId(interaction.guildId)
    : undefined;
}
