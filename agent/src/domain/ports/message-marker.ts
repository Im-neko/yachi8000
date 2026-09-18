/**
 * 「この投稿は処理した」という印をチャットに残す（F-37）。
 *
 * stocktrade の日次棚卸し（memo-triage）は ✅ が付いた投稿を読み飛ばす。
 * yachi8000 がその場で Issue にしたものへ印を残しておくと、夜の棚卸しが
 * 同じ投稿をもう一度分類しない。
 */
export interface MessageMarker {
  markHandled(channelId: string, messageId: string): Promise<void>;
}
