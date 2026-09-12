import type { Reminder } from '../reminder.ts';
import type { TenantId } from '../tenant.ts';

export interface ScheduleReminderInput {
  tenantId: TenantId;
  title: string;
  description: string | undefined;
  /** ISO 8601（UTC）。 */
  dueAt: string;
  channelId: string;
  guildId: string | undefined;
  createdBy: string | undefined;
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
  /** 未発火のものを期限の昇順で返す。 */
  listPending(tenantId: TenantId): readonly Reminder[];
  /** 消せたら true、そのテナントに無い / 既に発火済みなら false。 */
  cancel(tenantId: TenantId, id: string): boolean;
  /**
   * 期限が来た未発火のものを**発火済みにしてから**返す。
   *
   * 先に印を付けるので、配信に失敗した分は読み上げられないまま終わる。
   * 二重に読み上げるより、落としたことをログに残すほうがましという判断
   * （→ D-23）。
   */
  claimDue(now: string): readonly Reminder[];
}
