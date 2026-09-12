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

/**
 * キュレーターエージェント（F-40）のインスタンス ID の接頭辞。
 *
 * メインエージェントと**確実に別アドレス**になるように明示的に付ける。
 * 先行実装は `skill-curator:<tenantId>` だったが（→ C-07）、`:` は Flue の
 * 識別子で名前空間の区切りとして予約されているため、ここでは `-` を使う。
 */
const SKILL_CURATOR_PREFIX = 'skill-curator-';

export function skillCuratorInstanceId(tenantId: TenantId): string {
  return `${SKILL_CURATOR_PREFIX}${tenantId}`;
}

/**
 * キュレーターのインスタンス ID からテナントを復元する。
 *
 * キュレーターは自分がどのテナントを見ているかを知る必要があるが、
 * `initialData` はインスタンスを作った送信でしか効かない。ID から引く形に
 * すれば、何ターン後の dispatch でも同じ答えになる。
 */
export function tenantIdOfSkillCurator(instanceId: string): TenantId {
  if (!instanceId.startsWith(SKILL_CURATOR_PREFIX)) {
    throw new Error(
      `キュレーターのインスタンス ID ではありません: ${instanceId}`,
    );
  }
  const tenantId = instanceId.slice(SKILL_CURATOR_PREFIX.length);
  if (tenantId === '') {
    throw new Error(
      `キュレーターのインスタンス ID にテナントがありません: ${instanceId}`,
    );
  }
  return tenantId as TenantId;
}
