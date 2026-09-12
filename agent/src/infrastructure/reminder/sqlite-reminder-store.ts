import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ReminderStore,
  ScheduleReminderInput,
} from '../../domain/ports/reminder-store.ts';
import type { Reminder } from '../../domain/reminder.ts';
import type { TenantId } from '../../domain/tenant.ts';

interface ReminderRow {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  due_at: string;
  channel_id: string;
  guild_id: string | null;
  created_by: string | null;
  created_at: string;
  fired_at: string | null;
}

function toReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    tenantId: row.tenant_id as TenantId,
    title: row.title,
    description: row.description ?? undefined,
    dueAt: row.due_at,
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
       (id, tenant_id, title, description, due_at, channel_id, guild_id, created_by, created_at, fired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
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

  return {
    schedule(input: ScheduleReminderInput): Reminder {
      const reminder: Reminder = {
        id: randomUUID(),
        tenantId: input.tenantId,
        title: input.title,
        description: input.description,
        dueAt: input.dueAt,
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
        if (claim.run(now, row.id).changes === 0) continue;
        claimed.push(toReminder({ ...row, fired_at: now }));
      }
      return claimed;
    },
  };
}
