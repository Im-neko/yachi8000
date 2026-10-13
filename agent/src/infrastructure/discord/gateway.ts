import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { logger } from '../../observability/logger.ts';

/**
 * MESSAGE_CONTENT（特権インテント）を要求する。**Portal でも ON にしておくこと。**
 * 要求だけして Portal が OFF だと、Gateway 接続が `Used disallowed intents` で落ちる。
 *
 * DM と「Bot 宛のメンション」は特権インテント無しでも本文が読める例外だが、
 * 連続会話の窓（D-50）はメンションの無い発言の本文を読む必要がある。
 * 本文を読んでも、応答するのは DM・メンション・窓の中だけ（F-01）。
 *
 * GuildVoiceStates は `/vc-join` を引数なしで使えるようにするために要る
 * （呼んだ人が今いる VC を見る）。特権インテントではない。
 */
const INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.MessageContent,
  // 承認のリアクション（F-44）。**どちらも特権インテントではない。**
  // サーバとダイレクトメッセージで別々に要るので、片方だけだと
  // 「DM では押せるのにサーバでは反応しない」という形で欠ける。
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.DirectMessageReactions,
];

/** DM は partial で届くため、チャンネルとメッセージの partial を有効にする。 */
// **Reaction が要る。** 承認は数分後・数日後に押される。そのころには
// メッセージがキャッシュに無く、partial を許さないとイベントごと届かない。
const PARTIALS = [Partials.Channel, Partials.Message, Partials.Reaction];

/**
 * 接続中の Client を globalThis に置く。
 *
 * vite dev はコードを変えると SSR のモジュールグラフを「page reload」で
 * 丸ごと評価し直す。このときモジュールスコープの変数は初期値へ戻り、
 * `import.meta.hot.dispose` は呼ばれない（実測：ログに ready が 2 回出た）。
 * モジュールの外に置いた参照だけが再評価をまたいで残る。
 */
interface DiscordClientRegistry {
  __yachi8000DiscordClient?: Client;
}
const registry = globalThis as unknown as DiscordClientRegistry;

/**
 * Discord Gateway へ接続し、ready になるまで待つ。
 *
 * 同一トークンで Gateway へ 2 本繋ぐこと自体はできるが、**両方が同じイベントを
 * 受け取る**ので 1 通のメッセージに 2 回返信してしまう。運用ではレプリカ 1・
 * 更新戦略 Recreate で担保し（D-04）、開発時は再評価のたびに古い接続を閉じる。
 */
export async function startDiscordGateway(
  token: string,
): Promise<Client<true>> {
  const previous = registry.__yachi8000DiscordClient;
  if (previous) {
    logger.warn('Destroying the previous Discord client before re-login');
    await previous.destroy();
    registry.__yachi8000DiscordClient = undefined;
  }

  const created = new Client({ intents: INTENTS, partials: PARTIALS });
  registry.__yachi8000DiscordClient = created;

  created.on(Events.Error, (error) => {
    logger.error({ err: error }, 'Discord client error');
  });

  const ready = new Promise<Client<true>>((resolve) => {
    created.once(Events.ClientReady, (client) => {
      logger.info(
        { user: client.user.tag, id: client.user.id },
        'Discord gateway ready',
      );
      resolve(client);
    });
  });

  await created.login(token);
  return ready;
}
