declare const speakerIdBrand: unique symbol;

/**
 * 話しかけてくる人（F-05）。**入口で正規化してから上の層へ渡す。**
 *
 * 記憶は全体でひとつだが（→ D-35）、「誰の話か」は属性として残す。
 * プロフィールの鍵・長期記憶の帰属・リマインダーの登録者に使う。
 *
 * 名前空間を先頭に付けるのは、入口が増えたときに衝突させないため。
 *
 * **ブラウザから話しかけられた分も `discord-user-<id>` になる**（→ D-45）。
 * 認証基盤の利用者名から設定ファイルの対応表で引くので、Web 専用の話者は
 * 作らない —— 作ると同じ人の記憶が 2 つに割れる（D-35 で捨てたばかりの形）。
 */
export type SpeakerId = string & { readonly [speakerIdBrand]: true };

/** Discord のスノーフレーク。数字のみ。 */
const SNOWFLAKE = /^\d+$/;

/** Discord のユーザー単位の話者。 */
export function discordUserSpeakerId(userId: string): SpeakerId {
  if (!SNOWFLAKE.test(userId)) {
    throw new Error(`userId が Discord の ID の形式ではありません: ${userId}`);
  }
  return `discord-user-${userId}` as SpeakerId;
}

/**
 * デバッグ用ルート（`DEBUG_MODE=true`）の話者。
 *
 * 実在の人と同じ名前空間に入れない。**本番では生えない入口**なので
 * （`ENVIRONMENT=production` との併用は起動時に拒否される）、この ID の
 * プロフィールが本番へ混ざることはない。
 */
export function debugSpeakerId(): SpeakerId {
  return 'debug-user-local' as SpeakerId;
}

/**
 * 入口が載せた話者 ID を読み直す。
 *
 * Flue の delivery attributes は `Record<string, unknown>` で戻ってくるので、
 * ブランド型を復元する経路がここに要る。**形を検査してから通す** ——
 * 正規化されていない生の ID が紛れ込むと、プロフィールの鍵が二重になる。
 */
const SPEAKER_ID_PATTERN = /^[a-z]+-[a-z]+-.+$/;

export function parseSpeakerId(value: unknown): SpeakerId | undefined {
  if (typeof value !== 'string') return undefined;
  if (!SPEAKER_ID_PATTERN.test(value)) return undefined;
  return value as SpeakerId;
}

/** 設定ファイルに書かれた話者の指定（→ D-45）。 */
const DISCORD_USER_SPEAKER = /^discord-user-(\d+)$/;

/**
 * 対応表の値を読む。**形が違えば undefined。**
 *
 * 設定は人が手で書くので、綴り違いは普通に起こる。**黙って話者として
 * 通さない** —— 帰属の間違った長期記憶は、あとから選り分けられない。
 */
export function parseDiscordUserSpeaker(
  value: string,
): { speakerId: SpeakerId; userId: string } | undefined {
  const matched = DISCORD_USER_SPEAKER.exec(value);
  const userId = matched?.[1];
  if (!userId) return undefined;
  return { speakerId: value as SpeakerId, userId };
}
