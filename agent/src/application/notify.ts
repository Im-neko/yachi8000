import {
  composeNotificationFallback,
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

export type NotificationDisposition =
  | 'spoken'
  | 'delivered-as-text'
  | 'dropped';

/**
 * 通知を受理した時刻（epoch ミリ秒）。未受理なら undefined。
 *
 * **再生完了ではなく受理の時刻**を持つ。呼び出し側（Claude Code の hook）は
 * 「このターンで既に鳴らしたか」を判定するためにこれを見るので、長い応答の
 * 後ろにキューイングされている間も「受理済み」と分かる必要がある。
 *
 * 逆に、**届けられなかった通知では更新しない**。破棄した通知でここを進めると、
 * 「鳴らしていないのに鳴らした扱い」になって hook が黙る。
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
  const text = await rewriteOrDegrade(deps, notification);

  if (deps.voice.current()) {
    deps.speech.speak({ text, priority: 'notification' });
    lastAcceptedAt = acceptedAt;
    deps.log.info({ source: notification.source }, 'Speaking a notification');
    return 'spoken';
  }

  const { whenNotInVoice, fallbackChannelId } =
    deps.settings.get().notification;
  if (whenNotInVoice === 'text' && fallbackChannelId) {
    try {
      await deps.text.send(fallbackChannelId, text);
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
 * LLM による書き換え（F-16）。失敗したら決定的テンプレートへ縮退する。
 *
 * 縮退は house rule のフォールバック禁止の例外（意図的な部分縮退）であり、
 * **必ず WARN を出す**。黙って隠すと「LLM が壊れているのに動いて見える」。
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
    return composeNotificationFallback(notification);
  }
}
