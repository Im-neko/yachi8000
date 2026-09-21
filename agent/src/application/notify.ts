import {
  composeNotificationText,
  type Notification,
} from '../domain/notification.ts';
import type { NotificationRewriter } from '../domain/ports/notification-rewriter.ts';
import type { SettingsProvider } from '../domain/ports/settings-provider.ts';
import type { TextNotifier } from '../domain/ports/text-notifier.ts';
import type { SpeechService } from './speech.ts';

export interface NotifyDependencies {
  rewriter: NotificationRewriter;
  speech: SpeechService;
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
/** 外部通知の出どころ。宛先を持たないので、つながっている出口すべてへ出す。 */
const NOTIFICATION_ORIGIN = { kind: 'notification' } as const;

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

  // **VC にいるか**ではなく、**受け取る出口があるか**で決める（→ D-40）。
  // Discord と Web は対等なので、ブラウザだけが聞いていても読み上げる。
  if (deps.speech.canSpeak(NOTIFICATION_ORIGIN)) {
    deps.speech.speak({
      text: await rewriteOrDegrade(deps, notification),
      priority: 'notification',
      origin: NOTIFICATION_ORIGIN,
    });
    lastAcceptedAt = acceptedAt;
    deps.log.info({ source: notification.source }, 'Speaking a notification');
    return 'spoken';
  }

  const { whenNoOutput, fallbackChannelId } = settings;
  if (whenNoOutput === 'text' && fallbackChannelId) {
    try {
      await deps.text.send(
        fallbackChannelId,
        composeNotificationText(notification),
      );
      lastAcceptedAt = acceptedAt;
      deps.log.info(
        { source: notification.source, channelId: fallbackChannelId },
        'No output is listening — delivered the notification as text',
      );
      return 'delivered-as-text';
    } catch (error) {
      deps.log.error(
        {
          err: error,
          source: notification.source,
          channelId: fallbackChannelId,
        },
        'No output is listening and the text fallback failed — dropped the notification',
      );
      return 'dropped';
    }
  }

  deps.log.warn(
    {
      source: notification.source,
      whenNoOutput,
      hasFallbackChannel: Boolean(fallbackChannelId),
    },
    'No output is listening — dropped the notification',
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
  // （リマインダーの F-31 と同じ規則）。宛先をそのまま出どころに載せ、
  // どの出口が受け取るかは発話側が決める（→ D-40）。
  const origin = { kind: 'notification', guildId: target.guildId } as const;
  const spoken = deps.speech.canSpeak(origin);
  if (spoken) {
    deps.speech.speak({
      text: await rewriteOrDegrade(deps, notification),
      priority: 'notification',
      origin,
    });
  }

  const context = {
    source: notification.source,
    channel: notification.channel,
    channelId: target.channelId,
    spoken,
  };

  try {
    await deps.text.send(
      target.channelId,
      composeNotificationText(notification),
    );
    lastAcceptedAt = acceptedAt;
    deps.log.info(context, 'Delivered a notification to the addressed channel');
    return spoken ? 'spoken-and-delivered' : 'delivered-as-text';
  } catch (error) {
    deps.log.error(
      { ...context, err: error },
      'Failed to deliver a notification to the addressed channel',
    );
    // 読み上げは届いている。両方落ちたときだけ「受理しなかった」ことにする。
    if (spoken) {
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
