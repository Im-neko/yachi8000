import type { DeliveredMessageInput } from '@flue/runtime';
import { type Client, Events, type Message } from 'discord.js';
import { runAgentTurn } from '../../agents/run-turn.ts';
import type { SpeechService } from '../../application/speech.ts';
import {
  type ChannelMessage,
  renderChannelContext,
} from '../../domain/channel-context.ts';
import { ConversationWindow } from '../../domain/conversation-window.ts';
import { formatJstDate } from '../../domain/issue.ts';
import { shouldRespond } from '../../domain/response-policy.ts';
import { logger } from '../../observability/logger.ts';
import { conversationIdOf, speakerIdOf } from './conversation.ts';
import { splitForDiscord } from './outgoing.ts';

/**
 * 返信した相手が、この時間のうちに同じチャンネルで続けて書けば、メンション無しでも
 * 応答する（D-50）。返信のたびに開き直す。
 */
const CONVERSATION_WINDOW_MS = 10 * 60 * 1000;
const conversationWindow = new ConversationWindow(CONVERSATION_WINDOW_MS);

/**
 * チャンネルごとの、アシスタントが最後に返信したメッセージの ID。会話の履歴には
 * そこまでが入っているので、文脈に足すのはこれより後の発言だけにする。
 * 再起動で消える —— そのときは直近の発言を少し重ねて渡すだけで、困らない。
 */
const lastReplyIdByChannel = new Map<string, string>();
const CHANNEL_CONTEXT_FETCH = 15;
const CHANNEL_CONTEXT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface MessageHandlerDependencies {
  speech: SpeechService;
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

/** 本文と、embed の見出し・説明・項目（Alertmanager などはこちらに書く）。 */
function textOf(message: Message): string {
  const embeds = message.embeds.map((embed) =>
    [
      embed.title,
      embed.description,
      ...embed.fields.map((field) => `${field.name}: ${field.value}`),
    ]
      .filter((part): part is string => !!part)
      .join('\n'),
  );
  return [message.content, ...embeds].filter((part) => part !== '').join('\n');
}

/**
 * このチャンネルで、アシスタントの最後の返信より後の発言（D-50）。
 *
 * 会話の履歴にはアシスタントが宛てられたやりとりしか入らない。自分から出した
 * 投稿（見回り・リマインダー・通知）や他の人・Bot の発言を渡さないと、「ここで
 * 23% って」と言われても何のことか分からない。
 *
 * **取れなかったら文脈なしで続ける**が、黙らない（INV-7）。読み取りの権限が
 * 足りないときなどに落ちる。
 */
async function channelContextOf(
  message: Message,
  botId: string,
): Promise<string | undefined> {
  if (!message.inGuild()) return undefined;
  const cursor = lastReplyIdByChannel.get(message.channelId);
  const oldest = Date.now() - CHANNEL_CONTEXT_MAX_AGE_MS;
  try {
    const fetched = await message.channel.messages.fetch({
      limit: CHANNEL_CONTEXT_FETCH,
      before: message.id,
    });
    const recent: ChannelMessage[] = [...fetched.values()]
      .filter(
        (m) =>
          !m.system &&
          m.createdTimestamp >= oldest &&
          (cursor === undefined || BigInt(m.id) > BigInt(cursor)),
      )
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((m) => ({
        authorName: m.member?.displayName ?? m.author.displayName,
        fromAssistant: m.author.id === botId,
        fromBot: m.author.bot,
        postedAt: m.createdTimestamp,
        text: textOf(m),
      }));
    return renderChannelContext(recent);
  } catch (error) {
    logger.warn(
      { err: error, channelId: message.channelId },
      'Could not read the recent messages of the channel — continuing without the channel context',
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

  const speakerId = speakerIdOf(message);
  const respond = shouldRespond({
    isDirectMessage: message.channel.isDMBased(),
    mentionsAssistant,
    inConversationWindow: conversationWindow.isOpen(
      message.channelId,
      speakerId,
      Date.now(),
    ),
    mentionsSomeoneElse: message.mentions.users.some(
      (user) => user.id !== botId,
    ),
    authorIsBot: message.author.bot,
    hasText: text !== '',
  });
  if (!respond) return;

  const conversationId = conversationIdOf(message);
  const channelContext = await channelContextOf(message, botId);
  const delivered: DeliveredMessageInput = {
    kind: 'signal',
    type: 'discord.message',
    body: text,
    attributes: {
      // 正規化してから渡す（F-05）。生のスノーフレークを上の層へ漏らさない。
      speakerId,
      speakerName: message.author.displayName,
      channelId: message.channelId,
      // リマインダーの発火先を決めるのに使う（F-31）。DM には載らない。
      ...(message.inGuild() ? { guildId: message.guildId } : {}),
      // スレッドの中なら、その元投稿。Issue の出典に使う（F-37）。
      ...((await threadSourceOf(message)) ?? {}),
      // 直近の発言のうち、会話の履歴に入っていないもの（D-50）。
      ...(channelContext === undefined ? {} : { channelContext }),
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
  let lastSent: Message | undefined;
  for (const chunk of splitForDiscord(reply)) {
    // 1 通目だけ返信にする。以降を返信にすると同じメッセージへの
    // 引用が積み上がって読みにくい。
    lastSent = await (first ? message.reply(chunk) : channel.send(chunk));
    first = false;
  }
  // 次の文脈は、この返信より後の発言から取る。
  if (lastSent) lastReplyIdByChannel.set(message.channelId, lastSent.id);

  // DM は窓が要らない（常に応答する）。サーバのチャンネルだけ開く。
  if (message.inGuild()) {
    conversationWindow.open(message.channelId, speakerId, Date.now());
  }

  // **どの出口へ出すかは発話側が決める**（→ D-40）。ここは「どこから来た
  // 発言か」だけを渡す。同じサーバの VC にいるかどうか（F-12）も、
  // ブラウザが聞いているかどうか（F-23）も、判定は 1 箇所に置いてある。
  deps.speech.speak({
    text: reply,
    priority: 'reply',
    origin: { kind: 'conversation', guildId: message.guildId ?? undefined },
  });
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
