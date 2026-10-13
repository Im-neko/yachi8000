import type { ChannelMessage } from '../channel-context.ts';

export interface ChannelHistoryQuery {
  channelId: string;
  /** 1 回に取る件数（Discord の上限は 100）。 */
  limit: number;
  /** このメッセージ ID より前を取る。省略すると最新から。 */
  before?: string;
}

/**
 * チャンネルの発言の読み取り先（D-50）。**読むだけ。**
 *
 * 新しい順に返す。取れなかったことと 0 件は別 —— 前者は投げる。読み取りの権限が
 * 足りないときに「何も言われていない」と答えてしまわないため。
 */
export interface ChannelHistory {
  fetch(query: ChannelHistoryQuery): Promise<ChannelMessage[]>;
}
