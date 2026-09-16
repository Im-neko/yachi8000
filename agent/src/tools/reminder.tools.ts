import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
  cancelReminder,
  listReminders,
  scheduleRecurringReminder,
  scheduleReminder,
} from '../application/reminder.ts';
import { reminderDependencies } from '../composition-root.ts';
import {
  createRecurrence,
  describeRecurrence,
  formatJstDateTime,
  type Reminder,
} from '../domain/reminder.ts';
import type { TenantId } from '../domain/tenant.ts';

export interface ReminderToolsContext {
  tenantId: TenantId;
  /** 発火時の配信先。どのチャンネルの会話か分からない入口では undefined。 */
  channelId: string | undefined;
  /** ギルドの会話なら、そのギルド。DM なら undefined。 */
  guildId: string | undefined;
  /** 登録した人。分からなければ undefined。 */
  speakerId: string | undefined;
}

function formatReminder(reminder: Reminder): string {
  const due = formatJstDateTime(new Date(reminder.dueAt));
  const description = reminder.description ? `（${reminder.description}）` : '';
  const when = reminder.recurrence
    ? `${describeRecurrence(reminder.recurrence)}・次は ${due}`
    : due;
  return `- [${reminder.id}] ${when} ${reminder.title}${description}`;
}

/**
 * リマインダーの登録・一覧・削除（F-31）。
 *
 * 発火の読み上げは poller 側の仕事で、ここには無い。文面は保存したものが
 * そのまま読まれる（→ D-08）ので、**利用者の言葉を要約して保存しない**ことを
 * description で念押ししている。
 */
export function createReminderTools(ctx: ReminderToolsContext) {
  const schedule = defineTool({
    name: 'schedule_reminder',
    description:
      '指定した日時に 1 回だけリマインダーを鳴らします。「明日の 10 時に〜」「30 分後に〜」のように頼まれたときに使ってください。' +
      '「毎週火曜に〜」のように繰り返しを頼まれたときは、こちらではなく schedule_recurring_reminder を使ってください。' +
      'title には利用者の言葉をそのまま入れてください（発火時はこの文面がそのまま読み上げられるので、要約・言い換えをしないこと）。' +
      'due_at は日本時間の YYYY-MM-DDTHH:mm 形式です。相対的な指定は、プロンプトの Date を基準に自分で計算してください。',
    input: v.object({
      due_at: v.pipe(v.string(), v.minLength(1)),
      title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      description: v.optional(v.pipe(v.string(), v.maxLength(1000))),
    }),
    run({ data }) {
      if (!ctx.channelId) {
        throw new Error(
          'この会話にはリマインダーの配信先チャンネルがありません。Discord の会話から登録してください。',
        );
      }
      const reminder = scheduleReminder(reminderDependencies, {
        tenantId: ctx.tenantId,
        title: data.title,
        description: data.description,
        dueAtJst: data.due_at,
        channelId: ctx.channelId,
        guildId: ctx.guildId,
        createdBy: ctx.speakerId,
        now: new Date(),
      });
      return `${formatJstDateTime(new Date(reminder.dueAt))} に「${reminder.title}」で登録しました。(ID: ${reminder.id})`;
    },
  });

  const scheduleRecurring = defineTool({
    name: 'schedule_recurring_reminder',
    description:
      '繰り返しのリマインダーを登録します。「毎週火曜に〜」「毎朝〜」「毎週月・水・金に〜」のように頼まれたときに使ってください。' +
      'title には利用者の言葉をそのまま入れてください（発火時はこの文面がそのまま読み上げられるので、要約・言い換えをしないこと）。' +
      'time は日本時間の HH:mm 形式です。repeat が weekly のときは weekdays を 1 つ以上指定してください（daily では不要）。' +
      '「毎月〜」には対応していません。頼まれたら、毎日か毎週に言い換えられないかを尋ねてください。',
    input: v.object({
      repeat: v.picklist(['daily', 'weekly']),
      weekdays: v.optional(
        v.array(v.picklist(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])),
      ),
      time: v.pipe(v.string(), v.minLength(1)),
      title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      description: v.optional(v.pipe(v.string(), v.maxLength(1000))),
    }),
    run({ data }) {
      if (!ctx.channelId) {
        throw new Error(
          'この会話にはリマインダーの配信先チャンネルがありません。Discord の会話から登録してください。',
        );
      }
      const recurrence = createRecurrence({
        kind: data.repeat,
        weekdays: data.weekdays,
        time: data.time,
      });
      const reminder = scheduleRecurringReminder(reminderDependencies, {
        tenantId: ctx.tenantId,
        title: data.title,
        description: data.description,
        recurrence,
        channelId: ctx.channelId,
        guildId: ctx.guildId,
        createdBy: ctx.speakerId,
        now: new Date(),
      });
      return `${describeRecurrence(recurrence)} に「${reminder.title}」で登録しました。次は ${formatJstDateTime(new Date(reminder.dueAt))} です。(ID: ${reminder.id})`;
    },
  });

  const list = defineTool({
    name: 'list_reminders',
    description:
      'まだ鳴っていないリマインダーを期限の近い順に一覧します。繰り返しのものは規則と次回の時刻を並べます。削除対象の ID を調べるときにも使ってください。',
    input: v.object({}),
    run() {
      const reminders = listReminders(reminderDependencies, ctx.tenantId);
      if (reminders.length === 0)
        return '予定しているリマインダーはありません。';
      return reminders.map(formatReminder).join('\n');
    },
  });

  const cancel = defineTool({
    name: 'cancel_reminder',
    description:
      'リマインダーを 1 件削除します。繰り返しのものは、これで止めるまで鳴り続けます。ID は list_reminders が返す角括弧の中の値です。',
    input: v.object({
      id: v.pipe(v.string(), v.uuid()),
    }),
    run({ data }) {
      const removed = cancelReminder(reminderDependencies, {
        tenantId: ctx.tenantId,
        id: data.id,
      });
      return removed
        ? `リマインダー ${data.id} を削除しました。`
        : `リマインダー ${data.id} は見つかりませんでした（既に鳴ったか、別の会話のものです）。`;
    },
  });

  return [schedule, scheduleRecurring, list, cancel];
}
