/**
 * 外部から受け取った通知（F-15）。
 *
 * `source` はトークンから解決した送信元の識別子で、リクエスト本文には入らない。
 * 本文を名乗らせると、送信元を騙れてしまう（F-18）。
 */
export interface Notification {
  readonly source: string;
  readonly body: string;
}

/**
 * LLM による書き換え（F-16）に失敗したときの決定的な読み上げ文。
 *
 * house rule のフォールバック禁止の例外にあたる「意図的な部分縮退」。
 * 使ったことは必ず WARN に出す（application/notify.ts）。
 */
export function composeNotificationFallback(
  notification: Notification,
): string {
  return `${notification.source} からのメッセージです。${notification.body}`;
}
