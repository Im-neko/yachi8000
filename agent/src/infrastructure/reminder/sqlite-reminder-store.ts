import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ReminderStore,
  ScheduleReminderInput,
} from '../../domain/ports/reminder-store.ts';
import {
  nextOccurrence,
  type Recurrence,
  type Reminder,
} from '../../domain/reminder.ts';
import type { TenantId } from '../../domain/tenant.ts';

interface ReminderRow {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  due_at: string;
  recurrence: string | null;
  channel_id: string;
  guild_id: string | null;
  created_by: string | null;
  created_at: string;
  fired_at: string | null;
}

/**
 * 規則は JSON 文字列で持つ。**壊れていたら落とす。**
 *
 * 読めない行を黙って「1 回限り」として扱うと、繰り返すはずのものが 1 度
 * 鳴って消える —— 気付けない壊れ方（フォールバック禁止）。
 */
function decodeRecurrence(value: string | null): Recurrence | undefined {
  if (value === null) return undefined;

  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`繰り返しの規則として読めません: ${value}`);
  }
  const rule = parsed as Partial<Recurrence>;
  if (typeof rule.time !== 'string') {
    throw new Error(`繰り返しの規則に時刻がありません: ${value}`);
  }
  if (rule.kind === 'daily') return { kind: 'daily', time: rule.time };
  if (rule.kind === 'weekly') {
    // 形まで見ておく。kind だけ確かめて通すと、曜日の無い行が
    // `nextOccurrence` の中で TypeError になり、**その tick 全体**
    // （他テナント・1 回限りを含む）が毎回落ちる。
    if (!Array.isArray(rule.weekdays) || rule.weekdays.length === 0) {
      throw new Error(`繰り返しの規則に曜日がありません: ${value}`);
    }
    return { kind: 'weekly', weekdays: rule.weekdays, time: rule.time };
  }
  throw new Error(`繰り返しの種別として読めません: ${value}`);
}

function toReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    tenantId: row.tenant_id as TenantId,
    title: row.title,
    description: row.description ?? undefined,
    dueAt: row.due_at,
    recurrence: decodeRecurrence(row.recurrence),
    channelId: row.channel_id,
    guildId: row.guild_id ?? undefined,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    firedAt: row.fired_at ?? undefined,
  };
}

/**
 * リマインダーの SQLite 実装（F-31）。
 *
 * テナント分離は**この実装が必ず `tenant_id` の絞り込みとして行う**。
 * 呼び出し側にフィルタを任せない（長期記憶と同じ方針）。
 */
export function createSqliteReminderStore(db: DatabaseSync): ReminderStore {
  const insert = db.prepare(
    `INSERT INTO reminders
       (id, tenant_id, title, description, due_at, recurrence, channel_id, guild_id, created_by, created_at, fired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const selectPending = db.prepare(
    `SELECT * FROM reminders
      WHERE tenant_id = ? AND fired_at IS NULL
      ORDER BY due_at ASC`,
  );
  const deletePending = db.prepare(
    `DELETE FROM reminders
      WHERE tenant_id = ? AND id = ? AND fired_at IS NULL`,
  );
  const selectDue = db.prepare(
    `SELECT * FROM reminders
      WHERE fired_at IS NULL AND due_at <= ?
      ORDER BY due_at ASC`,
  );
  // 「発火済みにできた行だけを配信する」ための取り合い。fired_at IS NULL を
  // 条件に含めることで、同じ行を二度配信しない（→ D-23）。
  const claim = db.prepare(
    `UPDATE reminders SET fired_at = ?
      WHERE id = ? AND fired_at IS NULL`,
  );
  // 繰り返しは消さずに次回へ進める。due_at を条件に含めるのが取り合いの印で、
  // 1 回限りの fired_at IS NULL と同じ役割を果たす（→ D-29）。
  const advance = db.prepare(
    `UPDATE reminders SET due_at = ?
      WHERE id = ? AND due_at = ? AND fired_at IS NULL`,
  );

  return {
    schedule(input: ScheduleReminderInput): Reminder {
      const reminder: Reminder = {
        id: randomUUID(),
        tenantId: input.tenantId,
        title: input.title,
        description: input.description,
        dueAt: input.dueAt,
        recurrence: input.recurrence,
        channelId: input.channelId,
        guildId: input.guildId,
        createdBy: input.createdBy,
        createdAt: new Date().toISOString(),
        firedAt: undefined,
      };
      insert.run(
        reminder.id,
        reminder.tenantId,
        reminder.title,
        reminder.description ?? null,
        reminder.dueAt,
        reminder.recurrence === undefined
          ? null
          : JSON.stringify(reminder.recurrence),
        reminder.channelId,
        reminder.guildId ?? null,
        reminder.createdBy ?? null,
        reminder.createdAt,
      );
      return reminder;
    },

    listPending(tenantId: TenantId): readonly Reminder[] {
      return (selectPending.all(tenantId) as unknown as ReminderRow[]).map(
        toReminder,
      );
    },

    cancel(tenantId: TenantId, id: string): boolean {
      return deletePending.run(tenantId, id).changes > 0;
    },

    claimDue(now: string): readonly Reminder[] {
      const rows = selectDue.all(now) as unknown as ReminderRow[];
      const claimed: Reminder[] = [];
      for (const row of rows) {
        const reminder = toReminder(row);
        if (reminder.recurrence === undefined) {
          if (claim.run(now, row.id).changes === 0) continue;
          claimed.push({ ...reminder, firedAt: now });
          continue;
        }
        // 進める先は「`now` の次の回」。止まっていた間に過ぎた回はここで畳む。
        const next = nextOccurrence(reminder.recurrence, new Date(now));
        if (advance.run(next, row.id, row.due_at).changes === 0) continue;
        claimed.push(reminder);
      }
      return claimed;
    },
  };
}
