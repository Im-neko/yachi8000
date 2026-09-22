declare const conversationIdBrand: unique symbol;

/**
 * 短中期の会話文脈を分ける単位（F-04）。**記憶の分離単位ではない**（→ D-35）。
 *
 * 長期記憶・人格・スキル・リマインダーは全体でひとつの入れ物に持つ。ここで
 * 分けるのは「直前までのやり取り」だけで、別のサーバで交わした話が横から
 * 差し込まれないようにするためのもの。
 *
 * 値は Flue のエージェントインスタンス ID としてそのまま使う。Flue は
 * インスタンス ID を会話読み取り URL の 1 パスセグメントに載せる
 * （`assertAgentInstanceId` は非空しか要求しないが、`:` は識別子の名前空間
 * 区切りとして予約されている）。そのため区切り文字は `-` を使う。
 */
export type ConversationId = string & { readonly [conversationIdBrand]: true };

/** Discord のスノーフレーク。数字のみ。 */
const SNOWFLAKE = /^\d+$/;

function assertSnowflake(value: string, label: string): void {
  if (!SNOWFLAKE.test(value)) {
    throw new Error(`${label} が Discord の ID の形式ではありません: ${value}`);
  }
}

/** サーバ（ギルド）単位の会話。同じサーバ内の全チャンネルで 1 つ。 */
export function discordGuildConversationId(guildId: string): ConversationId {
  assertSnowflake(guildId, 'guildId');
  return `discord-guild-${guildId}` as ConversationId;
}

/** DM 単位の会話。相手ユーザーごとに 1 つ。 */
export function discordDirectMessageConversationId(
  userId: string,
): ConversationId {
  assertSnowflake(userId, 'userId');
  return `discord-dm-${userId}` as ConversationId;
}

/**
 * ブラウザから話しかけられたときの会話（F-13 の経路 B、→ D-47）。
 * **話者ごとに 1 つ。**
 *
 * **Discord の DM とは分ける。** 同じ人であっても（→ D-45）、返事の行き先が
 * 違う —— DM の返事は Discord に残り、こちらの返事はその場で読み上げて
 * 消える。混ぜると、声で言ったことが DM の履歴に混ざって見える。
 */
export function webConversationId(userId: string): ConversationId {
  assertSnowflake(userId, 'userId');
  return `web-${userId}` as ConversationId;
}

/**
 * キュレーターエージェント（F-40）のインスタンス ID の接頭辞。
 *
 * メインエージェントと**確実に別アドレス**になるように明示的に付ける。
 * 先行実装は `skill-curator:<tenantId>` だったが（→ C-07）、`:` は Flue の
 * 識別子で名前空間の区切りとして予約されているため、ここでは `-` を使う。
 */
const SKILL_CURATOR_PREFIX = 'skill-curator-';

/**
 * **インスタンスを分けるためだけの値。** キュレーター自身は自分がどの会話を
 * 見ているかを知らなくてよい —— 書き込む先のスキルストアは全体でひとつ
 * （→ D-35）。会話ごとに立てるのは、材料が 1 会話の 1 ターンだから。
 */
export function skillCuratorInstanceId(conversationId: ConversationId): string {
  return `${SKILL_CURATOR_PREFIX}${conversationId}`;
}
