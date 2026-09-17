import type { TenantId } from './tenant.ts';

/**
 * 日時指定のリマインダー（F-31）。
 *
 * 本文は**利用者が書いた文言のまま**持つ。保存された文面は、発火時に LLM が
 * 伝える一言を組み立てるための**素材**になる（→ D-30）。要約して保存すると
 * 素材の側が既に痩せていて、組み立てで取り返せない。
 */
export interface Reminder {
  id: string;
  tenantId: TenantId;
  /** 利用者が書いた見出し。読み上げでもそのまま使う。 */
  title: string;
  /** 補足。無ければ undefined。 */
  description: string | undefined;
  /** 次に鳴る時刻。ISO 8601（UTC）で持つ。 */
  dueAt: string;
  /** 繰り返しの規則。1 回限りなら undefined（→ D-29）。 */
  recurrence: Recurrence | undefined;
  /** 発火時の配信先。登録されたチャンネルへ返す。 */
  channelId: string;
  /** ギルドのリマインダーなら、そのギルド。DM なら undefined。 */
  guildId: string | undefined;
  /** 登録した人。分からなければ undefined。 */
  createdBy: string | undefined;
  createdAt: string;
  /**
   * 発火済みなら ISO 8601。未発火なら undefined。
   *
   * **繰り返しのリマインダーでは永久に undefined。** 鳴っても消えず、`dueAt`
   * が次回へ進むだけ（→ D-29）。この列は「まだ生きているか」の述語として
   * 一覧・削除・ポーリングの 3 箇所で引かれる。
   */
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
 * 文面づくり（D-30）に失敗したときの決定的な定型文（F-31）。
 *
 * **保存済みの title / description をそのまま並べるだけ。** 言い換えも要約も
 * しない。前置きの「リマインダーです。」は文の切れ目を作るための定型で、
 * 利用者の文言には手を入れない。
 *
 * house rule のフォールバック禁止の例外にあたる「意図的な部分縮退」。
 * 使ったことは必ず WARN に出す（application/reminder.ts）。
 */
export function composeReminderText(reminder: Reminder): string {
  const description = reminder.description?.trim();
  return description
    ? `リマインダーです。${reminder.title}\n${description}`
    : `リマインダーです。${reminder.title}`;
}

/** `Date.getUTCDay()` と同じ並び。JST へ寄せた時刻に対して引く。 */
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export type Weekday = (typeof WEEKDAYS)[number];

const WEEKDAY_LABELS: Readonly<Record<Weekday, string>> = {
  sun: '日',
  mon: '月',
  tue: '火',
  wed: '水',
  thu: '木',
  fri: '金',
  sat: '土',
};

/**
 * 繰り返しの規則（F-31）。
 *
 * **時刻は JST の `HH:mm`。** 1 回限りのリマインダーが絶対時刻を保存するのに
 * 対して、繰り返しは規則そのものを保存する —— 解決するのは発火のたびに
 * `nextOccurrence` で、**LLM は一切通らない**（→ D-29）。
 */
export type Recurrence =
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; weekdays: readonly Weekday[]; time: string };

export interface RecurrenceInput {
  kind: 'daily' | 'weekly';
  /** `weekly` のときだけ意味がある。空なら弾く。 */
  weekdays?: readonly string[] | undefined;
  /** JST の `HH:mm`。 */
  time: string;
}

const TIME_OF_DAY = /^(\d{2}):(\d{2})$/;

function parseTimeOfDay(input: string): { hour: number; minute: number } {
  const match = TIME_OF_DAY.exec(input.trim());
  if (!match) {
    throw new Error(
      `時刻の形式が違います（${input}）。HH:mm の形で、日本時間で指定してください。`,
    );
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`存在しない時刻です: ${input}`);
  }
  return { hour, minute };
}

function isWeekday(value: string): value is Weekday {
  return (WEEKDAYS as readonly string[]).includes(value);
}

/**
 * 繰り返しの規則を組み立てる。**壊れた入力はここで落とす。**
 *
 * 曜日は重複を潰して日曜起点に並べ替える。同じ規則が違う並びで保存されると、
 * 一覧の見え方が登録のたびに変わる。
 */
export function createRecurrence(input: RecurrenceInput): Recurrence {
  const time = input.time.trim();
  parseTimeOfDay(time);

  if (input.kind === 'daily') return { kind: 'daily', time };

  const given = input.weekdays ?? [];
  for (const weekday of given) {
    if (!isWeekday(weekday)) {
      throw new Error(
        `曜日として解釈できません: ${weekday}（${WEEKDAYS.join(' / ')} のいずれか）`,
      );
    }
  }
  const weekdays = WEEKDAYS.filter((weekday) => given.includes(weekday));
  if (weekdays.length === 0) {
    throw new Error('毎週のリマインダーには曜日を 1 つ以上指定してください。');
  }
  return { kind: 'weekly', weekdays, time };
}

/** JST は固定 +09:00（夏時間が無い）。この前提で日付計算をずらして行う。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `after` より**厳密に後**の、最初の発火時刻を UTC の ISO 8601 で返す。
 *
 * JST へ 9 時間ずらした空間で `getUTC*` だけを使って数える。`Intl` で文字列に
 * 直してから組み直すより短く、夏時間の無い固定オフセットでは厳密。
 *
 * 「ちょうどその時刻」を次回に数えないのは、発火直後の繰り上げで同じ回を
 * 二度鳴らさないため。
 */
export function nextOccurrence(rule: Recurrence, after: Date): string {
  const { hour, minute } = parseTimeOfDay(rule.time);
  const shifted = after.getTime() + JST_OFFSET_MS;
  const day = new Date(shifted);
  const first = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    hour,
    minute,
  );

  // 8 日あれば毎週のどの曜日にも必ず当たる。
  for (let offset = 0; offset < 8; offset += 1) {
    const at = first + offset * DAY_MS;
    if (at <= shifted) continue;
    if (rule.kind === 'weekly') {
      const weekday = WEEKDAYS[new Date(at).getUTCDay()];
      if (weekday === undefined || !rule.weekdays.includes(weekday)) continue;
    }
    return new Date(at - JST_OFFSET_MS).toISOString();
  }

  throw new Error(
    `次の発火時刻を決められませんでした: ${describeRecurrence(rule)}`,
  );
}

/** 一覧や登録の返事で見せる文言。 */
export function describeRecurrence(rule: Recurrence): string {
  if (rule.kind === 'daily') return `毎日 ${rule.time}`;
  const weekdays = rule.weekdays
    .map((weekday) => WEEKDAY_LABELS[weekday])
    .join('・');
  return `毎週${weekdays}曜 ${rule.time}`;
}
