import type { WebSearchResult } from '../web-search.ts';

export interface WebSearchQuery {
  query: string;
  limit: number;
}

/**
 * Web 検索の実行先（F-35）。
 *
 * 実装は 1 つの検索 API に閉じる。**結果が 0 件なのと検索できなかったのは
 * 別**で、後者は投げる —— 黙って「見つかりませんでした」に倒すと、キーが
 * 切れていても気付けない。
 */
export interface WebSearcher {
  search(query: WebSearchQuery): Promise<WebSearchResult[]>;
}
