import * as v from 'valibot';

const BooleanFlag = v.pipe(
  v.string(),
  v.transform((s) => ['true', '1', 'yes', 'on'].includes(s.toLowerCase())),
);

/**
 * `送信元:トークン` をカンマ区切りで並べたもの。
 *
 * 送信元にコロン・カンマ・空白は使えない。トークン側も空白とカンマを除く。
 */
const NOTIFY_TOKENS_PATTERN = /^[^\s:,]+:[^\s,]+(?:,[^\s:,]+:[^\s,]+)*$/;

const NotifyTokens = v.pipe(
  v.string(),
  v.trim(),
  v.regex(
    NOTIFY_TOKENS_PATTERN,
    'NOTIFY_TOKENS は "送信元:トークン" をカンマ区切りで並べます（例: claude-code:xxxx,ci:yyyy）。',
  ),
  v.transform((raw) =>
    raw.split(',').map((entry) => {
      const separator = entry.indexOf(':');
      return {
        source: entry.slice(0, separator),
        token: entry.slice(separator + 1),
      };
    }),
  ),
);

/**
 * 環境変数は「接続先と認証情報」だけを持つ。名前・人格・口調のような
 * ユーザー体験の定義は設定ファイル（F-60, SETTINGS_PATH）側にある。
 * 混ぜると、利用者が触ってよいものと運用者しか触れないものの境界が消える。
 */
const EnvSchema = v.object({
  PORT: v.optional(
    v.pipe(
      v.string(),
      v.transform(Number),
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(65535),
    ),
    '3000',
  ),
  ENVIRONMENT: v.optional(
    v.picklist(['production', 'staging', 'development', 'test']),
    'development',
  ),
  DEBUG_MODE: v.optional(BooleanFlag, 'false'),

  /**
   * 起動ログに出すバージョン。イメージのタグをそのまま入れる。
   * デプロイ後にログのバージョンが変わったことを確認できないと、
   * デプロイ失敗に気付かないまま古いイメージが動き続ける。
   */
  APP_VERSION: v.optional(v.pipe(v.string(), v.minLength(1)), 'dev'),

  /** LLM プロキシ（LiteLLM）の OpenAI 互換エンドポイント。`/v1` まで含める。 */
  LLM_PROXY_BASE_URL: v.pipe(v.string(), v.url()),
  LLM_PROXY_API_KEY: v.pipe(v.string(), v.minLength(1)),
  /** LLM プロキシの `model_list[].model_name`。起動時に実在を検証する。 */
  LLM_MODEL: v.pipe(v.string(), v.minLength(1)),

  DISCORD_BOT_TOKEN: v.pipe(v.string(), v.minLength(1)),

  /**
   * Issue を立てるためのトークン（F-37）。fine-grained PAT で、対象の
   * リポジトリに `issues: write` だけを与える。
   *
   * **任意。** 未設定でも起動はする（起票を頼まれたときだけ失敗する）。
   * どのリポジトリへ立てるかは設定ファイル側（`issueTracker.repositories`）。
   */
  GITHUB_TOKEN: v.optional(v.pipe(v.string(), v.minLength(1))),

  /**
   * 音声合成エンジンのベース URL（D-05）。エンジンは別 Deployment で動き、
   * yachi8000 は接続情報だけを受け取る。話者 ID は設定ファイル側（F-60）。
   */
  VOICEVOX_URL: v.pipe(v.string(), v.url()),

  /**
   * 通知 API（F-18）のトークン。`送信元:トークン` をカンマ区切りで並べる。
   *
   * 送信元は**トークンから決まる**。リクエスト本文に名乗らせると送信元を
   * 騙れる。k8s では Sealed Secret で渡し、平文を git に置かない。
   */
  NOTIFY_TOKENS: NotifyTokens,

  /** 長期記憶（pgvector）の接続先。会話履歴用の SQLite とは別物。 */
  MEMORY_DATABASE_URL: v.pipe(v.string(), v.minLength(1)),

  /**
   * Web 検索（F-35）の Brave Search API キー。
   *
   * キーなしで引ける検索は実測で使えなかった（→ D-27）。検索できないまま
   * 起動すると「調べて」に黙って答えられなくなるので、起動時に落とす。
   */
  BRAVE_SEARCH_API_KEY: v.pipe(v.string(), v.minLength(1)),

  /** Flue の会話履歴 SQLite。k8s では PVC 上のパスを渡す。 */
  FLUE_DB_PATH: v.optional(
    v.pipe(v.string(), v.minLength(1)),
    './data/flue.db',
  ),

  /**
   * ランタイム状態（リマインダー・スキル・人格差分）の SQLite。
   *
   * **Flue の会話履歴 DB とは別ファイルにする**（→ D-24）。会話履歴は Flue が
   * スキーマごと所有しているので相乗りしない。k8s では FLUE_DB_PATH と同じ
   * PVC 上のパスを渡す —— **values で渡し忘れると Pod 再起動ごとに消える。**
   */
  APP_DB_PATH: v.optional(
    v.pipe(v.string(), v.minLength(1)),
    './data/yachi.db',
  ),

  /** 静的設定（F-60）の YAML。PVC 上に置き、設定 UI もここへ書く。 */
  SETTINGS_PATH: v.optional(
    v.pipe(v.string(), v.minLength(1)),
    './data/settings.yaml',
  ),
});

export type Env = v.InferOutput<typeof EnvSchema>;

function loadEnv(): Env {
  const result = v.safeParse(EnvSchema, process.env);
  if (!result.success) {
    const issues = result.issues
      .map(
        (issue) =>
          `  - ${issue.path?.map((p) => p.key).join('.')}: ${issue.message}`,
      )
      .join('\n');
    throw new Error(`環境変数の検証に失敗しました:\n${issues}`);
  }
  if (result.output.ENVIRONMENT === 'production' && result.output.DEBUG_MODE) {
    throw new Error(
      '本番環境（ENVIRONMENT=production）で DEBUG_MODE=true は許可されていません。認証なしで発話させられる入口が開くため起動を中止します。',
    );
  }
  return result.output;
}

export const env = loadEnv();
