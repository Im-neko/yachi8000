import {
  composeNotificationText,
  type Notification,
} from '../domain/notification.ts';
import type { NotificationRewriter } from '../domain/ports/notification-rewriter.ts';
import type { SettingsProvider } from '../domain/ports/settings-provider.ts';
import type { TextNotifier } from '../domain/ports/text-notifier.ts';
import type { VoiceOutput } from '../domain/ports/voice-output.ts';
import type { SpeechService } from './speech.ts';

export interface NotifyDependencies {
  rewriter: NotificationRewriter;
  speech: SpeechService;
  voice: VoiceOutput;
  text: TextNotifier;
  settings: SettingsProvider;
  log: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
  };
}

/**
 * 通知をどう捌いたか。
 *
 * 宛先を指定した通知（D-31）では読み上げと記録が同時に起きうるので、
 * 「どちらが届いたか」が分かる形にしてある。`unknown-channel` だけは配信の
 * 結果ではなく**送信元の誤り**で、呼び出し側が 400 に写す。
 */
export type NotificationDisposition =
  | 'spoken'
  | 'delivered-as-text'
  | 'spoken-and-delivered'
  | 'dropped'
  | 'unknown-channel';

/**
 * 通知を受理した時刻（epoch ミリ秒）。未受理なら undefined。
 *
 * **再生完了ではなく受理の時刻**を持つ。呼び出し側（Claude Code の hook）は
 * 「このターンで既に鳴らしたか」を判定するためにこれを見るので、長い応答の
 * 後ろにキューイングされている間も「受理済み」と分かる必要がある。
 *
 * 逆に、**届けられなかった通知では更新しない**。破棄した通知でここを進めると、
 * 「鳴らしていないのに鳴らした扱い」になって hook が黙る。読み上げと記録の
 * どちらか一方でも届いていれば進める。
 */
let lastAcceptedAt: number | undefined;

export function lastNotificationAcceptedAt(): number | undefined {
  return lastAcceptedAt;
}

/**
 * 外部通知を受理して読み上げる（F-15〜F-19）。
 *
 * 読み上げ完了は待たない。戻り値は「どう捌いたか」であって「読み終えたか」
 * ではない。
 */
export async function notify(
  deps: NotifyDependencies,
  notification: Notification,
): Promise<NotificationDisposition> {
  const acceptedAt = Date.now();
  const settings = deps.settings.get().notification;

  if (notification.channel !== undefined) {
    const target = settings.channels?.[notification.channel];
    if (!target) {
      // 既定の宛先へ回さない。名前を間違えた通知が別のチャンネルへ出る方が、
      // 届かないことより悪い（→ INV-7）。
      deps.log.warn(
        { source: notification.source, channel: notification.channel },
        'Rejected a notification addressed to a channel that is not configured',
      );
      return 'unknown-channel';
    }
    return await deliverToNamedChannel(deps, notification, target, acceptedAt);
  }

  if (deps.voice.current()) {
    deps.speech.speak({
      text: await rewriteOrDegrade(deps, notification),
      priority: 'notification',
    });
    lastAcceptedAt = acceptedAt;
    deps.log.info({ source: notification.source }, 'Speaking a notification');
    return 'spoken';
  }

  const { whenNotInVoice, fallbackChannelId } = settings;
  if (whenNotInVoice === 'text' && fallbackChannelId) {
    try {
      await deps.text.send(
        fallbackChannelId,
        composeNotificationText(notification),
      );
      lastAcceptedAt = acceptedAt;
      deps.log.info(
        { source: notification.source, channelId: fallbackChannelId },
        'Not in a voice channel — delivered the notification as text',
      );
      return 'delivered-as-text';
    } catch (error) {
      deps.log.error(
        {
          err: error,
          source: notification.source,
          channelId: fallbackChannelId,
        },
        'Not in a voice channel and the text fallback failed — dropped the notification',
      );
      return 'dropped';
    }
  }

  deps.log.warn(
    {
      source: notification.source,
      whenNotInVoice,
      hasFallbackChannel: Boolean(fallbackChannelId),
    },
    'Not in a voice channel — dropped the notification',
  );
  return 'dropped';
}

/**
 * 宛先を名前で指定された通知の配信（F-15, D-31）。
 *
 * **記録が主、読み上げは従。** テキストは VC の接続状況に関わらず必ず残す
 * —— 宛先を指定してくるのは「残しておきたい」通知だからで、通話中かどうかで
 * 残るか消えるかが変わってはいけない。
 */
async function deliverToNamedChannel(
  deps: NotifyDependencies,
  notification: Notification,
  target: { readonly guildId: string; readonly channelId: string },
  acceptedAt: number,
): Promise<NotificationDisposition> {
  // 別サーバの VC にいるときに読み上げると、関係のない人へ内容が漏れる
  // （リマインダーの F-31 と同じ規則）。
  const inSameGuild = deps.voice.current()?.guildId === target.guildId;
  if (inSameGuild) {
    deps.speech.speak({
      text: await rewriteOrDegrade(deps, notification),
      priority: 'notification',
    });
  }

  const context = {
    source: notification.source,
    channel: notification.channel,
    channelId: target.channelId,
    spoken: inSameGuild,
  };

  try {
    await deps.text.send(
      target.channelId,
      composeNotificationText(notification),
    );
    lastAcceptedAt = acceptedAt;
    deps.log.info(context, 'Delivered a notification to the addressed channel');
    return inSameGuild ? 'spoken-and-delivered' : 'delivered-as-text';
  } catch (error) {
    deps.log.error(
      { ...context, err: error },
      'Failed to deliver a notification to the addressed channel',
    );
    // 読み上げは届いている。両方落ちたときだけ「受理しなかった」ことにする。
    if (inSameGuild) {
      lastAcceptedAt = acceptedAt;
      return 'spoken';
    }
    return 'dropped';
  }
}

/**
 * 読み上げ文の組み立て（F-16）。失敗したら決定的テンプレートへ縮退する。
 *
 * **書き換えるのは読み上げ文だけ。** チャンネルへ残す文面は
 * `composeNotificationText` のまま通す（→ D-31）。
 *
 * 縮退は house rule のフォールバック禁止の例外にあたる「意図的な部分縮退」で
 * あり、**必ず WARN を出す**。黙って隠すと「LLM が壊れているのに動いて見える」。
 */
async function rewriteOrDegrade(
  deps: NotifyDependencies,
  notification: Notification,
): Promise<string> {
  try {
    return await deps.rewriter.rewrite(notification);
  } catch (error) {
    deps.log.warn(
      { err: error, source: notification.source },
      'Failed to rewrite the notification — falling back to the deterministic template',
    );
    return composeNotificationText(notification);
  }
}
