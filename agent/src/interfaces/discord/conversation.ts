import type { Message } from 'discord.js';
import {
  type ConversationId,
  discordDirectMessageConversationId,
  discordGuildConversationId,
} from '../../domain/conversation.ts';
import { discordUserSpeakerId, type SpeakerId } from '../../domain/speaker.ts';

/**
 * このメッセージが属する会話（F-04）。
 *
 * サーバ内は全チャンネルで 1 つ、DM は相手ごとに 1 つ。チャンネル単位に
 * しないのは、同じサーバで交わした話を別チャンネルでも覚えていてほしいため
 * （→ D-22 の 2）。
 *
 * **分けているのは短中期の会話文脈だけ**（→ D-35）。長期記憶・人格・スキル・
 * リマインダーは全体でひとつの入れ物にある。
 */
export function conversationIdOf(message: Message): ConversationId {
  return message.inGuild()
    ? discordGuildConversationId(message.guildId)
    : discordDirectMessageConversationId(message.author.id);
}

/**
 * 発言した人（F-05）。**ここで正規化してから上の層へ渡す。**
 *
 * 生のスノーフレークを漏らすと、Web インターフェイスの話者が増えたときに
 * 名前空間が衝突する（INV-10 と同じ規則をテキストにも当てる）。
 */
export function speakerIdOf(message: Message): SpeakerId {
  return discordUserSpeakerId(message.author.id);
}
