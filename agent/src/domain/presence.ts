/**
 * カメラの前に人がいるか（F-26、→ D-46）。
 *
 * **映像はここまで届かない。** ブラウザが判定した結果だけが上がってくる。
 */

/**
 * **「いない」と「分からない」は別**（→ D-46 の 2）。
 *
 * 許可していない・タブが隠れた・カメラを取られた・判定器が落ちた ——
 * どれも「いない」ではない。潰すと、読み上げが理由の分からないまま止まる。
 */
export type Presence = 'present' | 'absent' | 'unknown';

/**
 * 報告が古くなるまでの時間。
 *
 * ブラウザは**変わったときだけ**送る（→ D-46 の 4）ので、黙っている間も
 * 状態は続いている。ただし**タブごと消えた場合は何も送られてこない** ——
 * それを「いない」のまま放置すると読み上げが止まり続ける。古くなったら
 * 「分からない」へ戻す。
 */
export const PRESENCE_TTL_MS = 120_000;

export interface PresenceReport {
  readonly state: Presence;
  /** 受け取った時刻（ミリ秒）。 */
  readonly at: number;
}

/**
 * 複数のタブ・端末の報告をひとつにまとめる。
 *
 * **誰か 1 人でもいれば「いる」。** 見ている端末が 2 つあって片方に人が
 * いないだけ、という状況で読み上げを止める理由は無い。
 *
 * **古い報告は数えない。** 数えると、閉じたタブの「いる」が残り続ける。
 */
export function aggregatePresence(
  reports: Iterable<PresenceReport>,
  now: number,
  ttlMs: number = PRESENCE_TTL_MS,
): Presence {
  let sawAbsent = false;
  for (const report of reports) {
    if (now - report.at > ttlMs) continue;
    if (report.state === 'present') return 'present';
    if (report.state === 'absent') sawAbsent = true;
  }
  return sawAbsent ? 'absent' : 'unknown';
}

/**
 * 会話へ渡す一言（F-26 の使い道 3）。**データとして渡す**（絶対ルール 6）
 * —— 「いま目の前にいる」は状況であって指示ではない。
 *
 * **「分からない」ときは何も言わない。** 書くと、カメラを使っていない
 * 人との会話にまで毎回「分かりません」が混ざる。
 */
export function renderPresence(state: Presence): string {
  switch (state) {
    case 'present':
      return '- いま、画面の前に人がいます。';
    case 'absent':
      return '- いま、画面の前に人がいません。';
    case 'unknown':
      return '';
  }
}
