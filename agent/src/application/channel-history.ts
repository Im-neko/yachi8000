import {
  type ChannelMessage,
  renderChannelContext,
} from '../domain/channel-context.ts';
import type { ChannelHistory } from '../domain/ports/channel-history.ts';

/** 毎ターン自動で渡す、直近の範囲（D-50）。 */
export const RECENT_CONTEXT_HOURS = 3;
export const RECENT_CONTEXT_MESSAGES = 30;

/** 道具で遡るときの上限。 */
export const HISTORY_DEFAULT_LIMIT = 20;
export const HISTORY_MAX_LIMIT = 30;
/** 部分一致で探すときに走査する件数の上限（Discord は検索 API を Bot に開放していない）。 */
export const HISTORY_MAX_SCAN = 300;

const PAGE = 100;

export interface ChannelHistoryDependencies {
  history: ChannelHistory;
}

/**
 * 自分に宛てられた発言の直前までの、直近数時間の発言（D-50）。
 *
 * 会話の履歴（Flue）にはアシスタントが宛てられたやりとりしか入らない。自分から
 * 出した投稿（見回り・通知）や他の人・Bot の発言を渡さないと、「ここで 23% って」
 * と言われても何のことか分からない。履歴と重なる分（自分の返信など）は構わず
 * 渡す —— 重なりを避けるための状態を持つより単純で、取りこぼさない。
 */
export async function recentChannelContext(
  deps: ChannelHistoryDependencies,
  query: { channelId: string; beforeMessageId: string; now: number },
): Promise<string | undefined> {
  const fetched = await deps.history.fetch({
    channelId: query.channelId,
    before: query.beforeMessageId,
    limit: RECENT_CONTEXT_MESSAGES,
  });
  const oldest = query.now - RECENT_CONTEXT_HOURS * 60 * 60 * 1000;
  return renderChannelContext(
    fetched.filter((m) => m.postedAt >= oldest).reverse(),
  );
}

export interface HistorySearch {
  channelId: string;
  /** このメッセージ ID より前から遡る。省略すると最新から。 */
  before?: string;
  limit?: number;
  /** 本文に含まれる文字列（大文字小文字は区別しない）。指定すると走査して絞る。 */
  contains?: string;
}

export interface HistorySearchResult {
  /** 古い順。 */
  messages: ChannelMessage[];
  /** さらに遡るときの `before`。これ以上遡れないなら undefined。 */
  nextBefore: string | undefined;
  scanned: number;
}

/**
 * チャンネルを遡って読む（D-50）。**読むだけ。**
 *
 * `contains` を指定したときは新しい方から最大 `HISTORY_MAX_SCAN` 件を走査して
 * 一致するものだけを返す。走査の範囲を超えて古い発言は、`nextBefore` から続けて探す。
 */
export async function searchChannelHistory(
  deps: ChannelHistoryDependencies,
  search: HistorySearch,
): Promise<HistorySearchResult> {
  const limit = Math.min(
    Math.max(search.limit ?? HISTORY_DEFAULT_LIMIT, 1),
    HISTORY_MAX_LIMIT,
  );
  const needle = search.contains?.toLowerCase();
  const matched: ChannelMessage[] = [];
  let before = search.before;
  let scanned = 0;
  let exhausted = false;

  while (matched.length < limit && scanned < HISTORY_MAX_SCAN) {
    const page = await deps.history.fetch({
      channelId: search.channelId,
      before,
      limit: needle === undefined ? limit : PAGE,
    });
    if (page.length === 0) {
      exhausted = true;
      break;
    }
    for (const message of page) {
      scanned += 1;
      before = message.id;
      if (needle === undefined || message.text.toLowerCase().includes(needle)) {
        matched.push(message);
        if (matched.length >= limit) break;
      }
    }
    // 絞り込みが無ければ 1 ページで足りる。
    if (needle === undefined) break;
  }

  return {
    messages: matched.reverse(),
    nextBefore: exhausted ? undefined : before,
    scanned,
  };
}
