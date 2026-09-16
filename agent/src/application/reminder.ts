import type {
  ReminderStore,
  ScheduleReminderInput,
} from '../domain/ports/reminder-store.ts';
import type { TextNotifier } from '../domain/ports/text-notifier.ts';
import type { VoiceOutput } from '../domain/ports/voice-output.ts';
import {
  composeReminderText,
  describeRecurrence,
  nextOccurrence,
  parseJstDueAt,
  type Recurrence,
  type Reminder,
} from '../domain/reminder.ts';
import type { TenantId } from '../domain/tenant.ts';
import type { SpeechService } from './speech.ts';

/** 1 テナントに溜められる未発火のリマインダー数。 */
const MAX_PENDING_PER_TENANT = 100;

export interface ReminderDependencies {
  store: ReminderStore;
}

export interface ReminderDeliveryDependencies extends ReminderDependencies {
  speech: SpeechService;
  voice: VoiceOutput;
  text: TextNotifier;
  log: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
}

export interface ScheduleReminderRequest
  extends Omit<ScheduleReminderInput, 'dueAt' | 'recurrence'> {
  /** JST の `YYYY-MM-DDTHH:mm`。エージェントに渡している現在時刻と同じ形式。 */
  dueAtJst: string;
  /** 過去判定の基準。呼び出し側が渡す（テストで固定できるように）。 */
  now: Date;
}

export interface ScheduleRecurringReminderRequest
  extends Omit<ScheduleReminderInput, 'dueAt' | 'recurrence'> {
  recurrence: Recurrence;
  /** 最初の回を決める基準。呼び出し側が渡す（テストで固定できるように）。 */
  now: Date;
}

function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed === '') {
    throw new Error('リマインダーの内容が空です。');
  }
  return trimmed;
}

function normalizeDescription(
  description: string | undefined,
): string | undefined {
  const trimmed = description?.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 積み上がりすぎていないかを見る。
 *
 * **繰り返しのリマインダーも同じ枠で数える。** 鳴っても消えないぶん、
 * 上限に効かせておかないと際限なく溜まる。
 */
function ensureCapacity(deps: ReminderDependencies, tenantId: TenantId): void {
  const pending = deps.store.listPending(tenantId);
  if (pending.length >= MAX_PENDING_PER_TENANT) {
    throw new Error(
      `未発火のリマインダーが上限（${MAX_PENDING_PER_TENANT} 件）に達しています。先に不要なものを削除してください。`,
    );
  }
}

/**
 * リマインダーを登録する（F-31）。
 *
 * 過去の時刻は拒む。「登録できたのに鳴らない」が最も分かりにくい壊れ方で、
 * poller は未来しか見ないため黙って消える。
 */
export function scheduleReminder(
  deps: ReminderDependencies,
  request: ScheduleReminderRequest,
): Reminder {
  const title = normalizeTitle(request.title);

  const dueAt = parseJstDueAt(request.dueAtJst);
  if (new Date(dueAt).getTime() <= request.now.getTime()) {
    throw new Error(
      `${request.dueAtJst} は過去の時刻です。未来の日時を指定してください。`,
    );
  }

  ensureCapacity(deps, request.tenantId);

  return deps.store.schedule({
    tenantId: request.tenantId,
    title,
    description: normalizeDescription(request.description),
    dueAt,
    recurrence: undefined,
    channelId: request.channelId,
    guildId: request.guildId,
    createdBy: request.createdBy,
  });
}

/**
 * 繰り返しのリマインダーを登録する（F-31, D-29）。
 *
 * 保存するのは**規則**で、最初の `dueAt` はそこから決める。以後は発火の
 * たびにストアが次回へ進める。過去判定が要らないのは、`nextOccurrence` が
 * 必ず `now` より後を返すため。
 */
export function scheduleRecurringReminder(
  deps: ReminderDependencies,
  request: ScheduleRecurringReminderRequest,
): Reminder {
  const title = normalizeTitle(request.title);
  ensureCapacity(deps, request.tenantId);

  return deps.store.schedule({
    tenantId: request.tenantId,
    title,
    description: normalizeDescription(request.description),
    dueAt: nextOccurrence(request.recurrence, request.now),
    recurrence: request.recurrence,
    channelId: request.channelId,
    guildId: request.guildId,
    createdBy: request.createdBy,
  });
}

export function listReminders(
  deps: ReminderDependencies,
  tenantId: TenantId,
): readonly Reminder[] {
  return deps.store.listPending(tenantId);
}

export function cancelReminder(
  deps: ReminderDependencies,
  input: { tenantId: TenantId; id: string },
): boolean {
  return deps.store.cancel(input.tenantId, input.id);
}

/**
 * 期限が来たものを配信する（F-31）。固定間隔の poller から呼ぶ。
 *
 * **LLM をまったく通さない。** 文面は保存済みの title / description から
 * 決定的に組む（→ D-08）。
 *
 * 配信は「登録されたチャンネルへのテキスト」が本体で、**同じサーバの VC に
 * 繋いでいるときだけ**声も出す。DM のリマインダーを繋いでいる VC で読み上げ
 * るのは宛先として筋が通らない（message-handler と同じ判定）。
 *
 * @returns 配信を試みた件数。
 */
export async function fireDueReminders(
  deps: ReminderDeliveryDependencies,
  now: Date,
): Promise<number> {
  const due = deps.store.claimDue(now.toISOString());
  if (due.length === 0) return 0;

  for (const reminder of due) {
    const text = composeReminderText(reminder);
    warnOnSkippedOccurrences(deps, reminder, now);

    const inSameGuild =
      reminder.guildId !== undefined &&
      deps.voice.current()?.guildId === reminder.guildId;
    if (inSameGuild) {
      deps.speech.speak({ text, priority: 'reminder' });
    }

    try {
      await deps.text.send(reminder.channelId, text);
      deps.log.info(
        {
          reminderId: reminder.id,
          tenantId: reminder.tenantId,
          spoken: inSameGuild,
        },
        'Fired a reminder',
      );
    } catch (error) {
      // 発火済みの印は既に立っている。再送しないのは、二重に読み上げる方が
      // 取り落とすより悪いという判断（→ D-23）。落としたことは必ず出す。
      deps.log.error(
        {
          err: error,
          reminderId: reminder.id,
          tenantId: reminder.tenantId,
          channelId: reminder.channelId,
        },
        'Fired a reminder but failed to deliver it as text — it will not be retried',
      );
    }
  }

  return due.length;
}

/**
 * 止まっていた間に過ぎた回を畳んだことを記録する（→ D-29, INV-7）。
 *
 * 繰り返しは `now` の次の回へ一気に進むので、3 日止まっていた毎日の
 * リマインダーは 3 回ではなく 1 回だけ鳴る。**意図した部分縮退なので、
 * WARN で残す。**
 */
function warnOnSkippedOccurrences(
  deps: ReminderDeliveryDependencies,
  reminder: Reminder,
  now: Date,
): void {
  if (reminder.recurrence === undefined) return;
  const following = nextOccurrence(
    reminder.recurrence,
    new Date(reminder.dueAt),
  );
  if (new Date(following).getTime() > now.getTime()) return;

  deps.log.warn(
    {
      reminderId: reminder.id,
      tenantId: reminder.tenantId,
      recurrence: describeRecurrence(reminder.recurrence),
      dueAt: reminder.dueAt,
    },
    'Collapsed missed occurrences of a recurring reminder into a single delivery',
  );
}
