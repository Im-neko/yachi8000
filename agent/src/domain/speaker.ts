declare const speakerIdBrand: unique symbol;

/**
 * 話しかけてくる人（F-05）。**入口で正規化してから上の層へ渡す。**
 *
 * 記憶は全体でひとつだが（→ D-35）、「誰の話か」は属性として残す。
 * プロフィールの鍵・長期記憶の帰属・リマインダーの登録者に使う。
 *
 * 名前空間を先頭に付けるのは、**将来 Web インターフェイスの話者が
 * 増えたときに衝突させないため**（`web-user-<id>`）。同一人物として
 * 結び付けるかどうかは、そのときに改めて決める（今は結び付けない）。
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
