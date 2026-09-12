import type { TenantId } from './tenant.ts';

/**
 * 日時指定のリマインダー（F-31）。
 *
 * 本文は**利用者が書いた文言のまま**持つ。読み上げ時に LLM で言い換えない
 * （→ D-08）。外部通知（F-16）とはここが逆で、通知は自然文に馴染ませることに
 * 価値があり、リマインダーは書いたとおりに思い出させることに価値がある。
 */
export interface Reminder {
  id: string;
  tenantId: TenantId;
  /** 利用者が書いた見出し。読み上げでもそのまま使う。 */
  title: string;
  /** 補足。無ければ undefined。 */
  description: string | undefined;
  /** 期限。ISO 8601（UTC）で持つ。 */
  dueAt: string;
  /** 発火時の配信先。登録されたチャンネルへ返す。 */
  channelId: string;
  /** ギルドのリマインダーなら、そのギルド。DM なら undefined。 */
  guildId: string | undefined;
  /** 登録した人。分からなければ undefined。 */
  createdBy: string | undefined;
  createdAt: string;
  /** 発火済みなら ISO 8601。未発火なら undefined。 */
  firedAt: string | undefined;
}

/** エージェントのプロンプトが受け取る現在時刻と同じ形式（分精度の JST）。 */
const JST_LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * `YYYY-MM-DDTHH:mm`（JST）を UTC の ISO 8601 に直す。
 *
 * エージェントには同じ形式の現在時刻を渡してあるので、モデルはオフセットを
 * 考えずに済む。**JST は固定 +09:00 で夏時間が無いため、変換は厳密。**
 *
 * `2026-02-31T10:00` のような存在しない日付は Date が繰り上げて黙って通すので、
 * 変換結果を JST で組み直して一致を確かめる。
 */
export function parseJstDueAt(input: string): string {
  const match = JST_LOCAL_DATE_TIME.exec(input.trim());
  if (!match) {
    throw new Error(
      `期限の形式が違います（${input}）。YYYY-MM-DDTHH:mm の形で、日本時間で指定してください。`,
    );
  }

  const date = new Date(`${match[0]}:00+09:00`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`期限として解釈できません: ${input}`);
  }
  if (formatJstDateTime(date) !== match[0]) {
    throw new Error(`存在しない日時です: ${input}`);
  }
  return date.toISOString();
}

/** JST の `YYYY-MM-DDTHH:mm` に整形する。表示と検算の両方で使う。 */
export function formatJstDateTime(date: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(date)
    .replace(' ', 'T');
}

/**
 * 発火時の文面（F-31, D-08）。
 *
 * **保存済みの title / description をそのまま並べるだけ。** 言い換えも要約も
 * しない。前置きの「リマインダーです。」は文の切れ目を作るための定型で、
 * 利用者の文言には手を入れない。
 */
export function composeReminderText(reminder: Reminder): string {
  const description = reminder.description?.trim();
  return description
    ? `リマインダーです。${reminder.title}\n${description}`
    : `リマインダーです。${reminder.title}`;
}
