import type { DeliveredMessageInput } from '@flue/runtime';
import { type Client, Events, type Message } from 'discord.js';
import { runAgentTurn } from '../../agents/run-turn.ts';
import type { SpeechService } from '../../application/speech.ts';
import type { VoiceSessionDependencies } from '../../application/voice-session.ts';
import { currentVoiceChannel } from '../../application/voice-session.ts';
import { formatJstDate } from '../../domain/issue.ts';
import { shouldRespond } from '../../domain/response-policy.ts';
import { logger } from '../../observability/logger.ts';
import { conversationIdOf, speakerIdOf } from './conversation.ts';
import { splitForDiscord } from './outgoing.ts';

export interface MessageHandlerDependencies {
  speech: SpeechService;
  voice: VoiceSessionDependencies;
}

/** 本文から Bot 自身へのメンションを落とす。宛先の記号はモデルには不要。 */
function stripSelfMention(content: string, botId: string): string {
  return content.replaceAll(new RegExp(`<@!?${botId}>`, 'g'), ' ').trim();
}

/**
 * スレッドの元になった投稿（F-37）。Issue の出典に使う。
 *
 * **取れなかったら載せない。** 親が消えている・古くて引けない・権限が
 * 足りないときに、代わりにスレッド内の適当な発言を出典にすると、
 * 元投稿と無関係な Issue が立つ。出典が決まらないときは起票の道具自体を
 * 配らない（→ D-33）。
 */
async function threadSourceOf(
  message: Message,
): Promise<Record<string, string> | undefined> {
  const channel = message.channel;
  if (!channel.isThread() || !channel.parentId) return undefined;

  try {
    const starter = await channel.fetchStarterMessage();
    if (!starter) return undefined;
    return {
      threadParentChannelId: channel.parentId,
      threadStarterMessageId: starter.id,
      threadStarterText: starter.content,
      threadStarterUrl: starter.url,
      threadStarterPostedOn: formatJstDate(starter.createdAt),
    };
  } catch (error) {
    logger.warn(
      { err: error, threadId: channel.id },
      'Could not read the thread starter message — issue creation stays unavailable here',
    );
    return undefined;
  }
}

async function handleMessage(
  client: Client<true>,
  message: Message,
  deps: MessageHandlerDependencies,
) {
  const botId = client.user.id;
  const mentionsAssistant = message.mentions.users.has(botId);
  const text = stripSelfMention(message.content, botId);

  if (
    text === '' &&
    !message.author.bot &&
    (message.channel.isDMBased() || mentionsAssistant)
  ) {
    logger.warn(
      { channelType: message.channel.type, messageId: message.id },
      'Received an addressed message with empty content — the MESSAGE_CONTENT intent may be required',
    );
  }

  const respond = shouldRespond({
    isDirectMessage: message.channel.isDMBased(),
    mentionsAssistant,
    authorIsBot: message.author.bot,
    hasText: text !== '',
  });
  if (!respond) return;

  const conversationId = conversationIdOf(message);
  const delivered: DeliveredMessageInput = {
    kind: 'signal',
    type: 'discord.message',
    body: text,
    attributes: {
      // 正規化してから渡す（F-05）。生のスノーフレークを上の層へ漏らさない。
      speakerId: speakerIdOf(message),
      speakerName: message.author.displayName,
      channelId: message.channelId,
      // リマインダーの発火先を決めるのに使う（F-31）。DM には載らない。
      ...(message.inGuild() ? { guildId: message.guildId } : {}),
      // スレッドの中なら、その元投稿。Issue の出典に使う（F-37）。
      ...((await threadSourceOf(message)) ?? {}),
    },
  };

  const channel = message.channel;
  if (!channel.isSendable()) {
    logger.warn(
      { conversationId, channelType: channel.type },
      'Cannot reply — the bot lacks send permission on this channel',
    );
    return;
  }

  await channel.sendTyping();

  const reply = await runAgentTurn({ conversationId, message: delivered });
  if (!reply) {
    logger.warn(
      { conversationId, messageId: message.id },
      'Agent returned no text',
    );
    return;
  }

  let first = true;
  for (const chunk of splitForDiscord(reply)) {
    // 1 通目だけ返信にする。以降を返信にすると同じメッセージへの
    // 引用が積み上がって読みにくい。
    await (first ? message.reply(chunk) : channel.send(chunk));
    first = false;
  }

  // 同じサーバの VC にいるときだけ声にする（F-12）。DM や別サーバの
  // 発言を、繋いでいる VC で読み上げるのは宛先として筋が通らない。
  if (currentVoiceChannel(deps.voice)?.guildId === message.guildId) {
    deps.speech.speak({ text: reply, priority: 'reply' });
  }
}

export function registerMessageHandler(
  client: Client<true>,
  deps: MessageHandlerDependencies,
): void {
  client.on(Events.MessageCreate, (message) => {
    handleMessage(client, message, deps).catch((error) => {
      logger.error(
        { err: error, messageId: message.id },
        'Failed to handle Discord message',
      );
    });
  });
}
