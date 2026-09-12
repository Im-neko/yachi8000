/**
 * 外部から受け取った通知（F-15）。
 *
 * `source` はトークンから解決した送信元の識別子で、リクエスト本文には入らない。
 * 本文を名乗らせると、送信元を騙れてしまう（F-18）。
 *
 * `role` は**送信元が申告する肩書き**で、こちらは検証しない。並列に動いている
 * 送信元を区別するためのもの（「レビュー担当」「デプロイ監視」など）。`source`
 * と混ぜて表示しないこと —— 騙れる値と騙れない値を同じ見え方にすると、
 * 認証している意味が薄れる。
 */
export interface Notification {
  readonly source: string;
  readonly body: string;
  readonly role?: string | undefined;
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
  const role = notification.role?.trim();
  const who = role ? `${notification.source}（${role}）` : notification.source;
  return `${who} からのメッセージです。${notification.body}`;
}
