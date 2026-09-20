import type { Recurrence, Reminder } from '../reminder.ts';
import type { SpeakerId } from '../speaker.ts';

export interface ScheduleReminderInput {
  title: string;
  description: string | undefined;
  /** 最初に鳴る時刻。ISO 8601（UTC）。 */
  dueAt: string;
  /** 繰り返しの規則。1 回限りなら undefined（→ D-29）。 */
  recurrence: Recurrence | undefined;
  channelId: string;
  guildId: string | undefined;
  createdBy: SpeakerId | undefined;
}

/**
 * リマインダーの保存先（F-31）。
 *
 * ツール（登録・削除）と poller（発火更新）が同じ行を触る。`claim` が
 * 「発火済みにする」と「取り出す」を 1 手でやるのはそのため。
 *
 * 同期にしてあるのは実装が `node:sqlite`（同期ドライバ）だからではなく、
 * ここを非同期にすると poller とツールの間に待ち時間が生まれ、二重発火の
 * 隙ができるため。
 */
export interface ReminderStore {
  schedule(input: ScheduleReminderInput): Reminder;
  /** その人が登録した未発火のものを、期限の昇順で返す（→ D-35）。 */
  listPending(createdBy: SpeakerId): readonly Reminder[];
  /** 未発火で、かつ**その人が登録したもの**だけを消す。消せたら true。 */
  cancel(createdBy: SpeakerId, id: string): boolean;
  /** その人の未発火の件数。登録の上限を判定するために引く（F-31）。 */
  countPending(createdBy: SpeakerId): number;
  /**
   * 期限が来た未発火のものを**先に進めてから**返す。
   *
   * - 1 回限り: `fired_at` を立てる。以後どのクエリにも出てこない
   * - 繰り返し: `due_at` を `now` の次の回へ進める。`fired_at` は触らない
   *   （→ D-29）。**止まっていた間に過ぎた回はまとめて鳴らさず、1 回に畳む**
   *
   * どちらも先に印を付けるので、配信に失敗した分は読み上げられないまま
   * 終わる。二重に読み上げるより、落としたことをログに残すほうがましという
   * 判断（→ D-23）。
   *
   * 返す `Reminder` は**鳴った回**のスナップショット —— `dueAt` は進める前の
   * 値で、繰り返しでも `firedAt` は undefined のまま。
   */
  claimDue(now: string): readonly Reminder[];
}
