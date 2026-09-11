declare const tenantIdBrand: unique symbol;

/**
 * 会話履歴・長期記憶・リマインダー・スキルを分離する単位（F-04）。
 * Flue のエージェントインスタンス ID と pgvector の `tenant_id` 列の両方で
 * 同じ値を使うので、片方だけ採番規則を変えると記憶が迷子になる。
 *
 * Flue はインスタンス ID を会話読み取り URL の 1 パスセグメントに載せる
 * （`assertAgentInstanceId` は非空しか要求しないが、`:` は識別子の名前空間
 * 区切りとして予約されている）。そのため区切り文字は `-` を使う。
 */
export type TenantId = string & { readonly [tenantIdBrand]: true };

/** Discord のスノーフレーク。数字のみ。 */
const SNOWFLAKE = /^\d+$/;

function assertSnowflake(value: string, label: string): void {
  if (!SNOWFLAKE.test(value)) {
    throw new Error(`${label} が Discord の ID の形式ではありません: ${value}`);
  }
}

/** サーバ（ギルド）単位のテナント。同じサーバ内の全チャンネルで 1 つ。 */
export function discordGuildTenantId(guildId: string): TenantId {
  assertSnowflake(guildId, 'guildId');
  return `discord-guild-${guildId}` as TenantId;
}

/** DM 単位のテナント。相手ユーザーごとに 1 つ。 */
export function discordDirectMessageTenantId(userId: string): TenantId {
  assertSnowflake(userId, 'userId');
  return `discord-dm-${userId}` as TenantId;
}
