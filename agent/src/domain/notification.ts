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
 *
 * `channel` は**設定に置かれた配信先の名前**（F-15, D-31）。チャンネル ID
 * そのものではない。指定があれば、VC の接続状況に関わらずそのチャンネルへ
 * 必ず残す。
 */
export interface Notification {
  readonly source: string;
  readonly body: string;
  readonly role?: string | undefined;
  readonly channel?: string | undefined;
}

/**
 * チャンネルへ残す文面（F-15, D-31）。
 *
 * **テキストは必ずこれを使う。LLM の書き換え（F-16）を通さない。**
 * 書き換えは読み上げを自然にするためのもので、記録に残る文面の数値や固有名詞を
 * 書き換えてよい理由にはならない（→ D-31）。
 *
 * 読み上げ側では、書き換えに失敗したときの縮退先としても使う。縮退は house rule
 * のフォールバック禁止の例外にあたる「意図的な部分縮退」であり、使ったことは
 * 必ず WARN に出す（application/notify.ts）。
 */
export function composeNotificationText(notification: Notification): string {
  const role = notification.role?.trim();
  const who = role ? `${notification.source}（${role}）` : notification.source;
  return `${who} からのメッセージです。${notification.body}`;
}
