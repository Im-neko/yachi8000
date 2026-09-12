import type { WebSearcher } from '../domain/ports/web-search.ts';
import type { WebSearchResult } from '../domain/web-search.ts';

/** 1 回の検索で読む最大件数。読み上げ・チャットで扱える量に絞る。 */
const SEARCH_LIMIT = 5;

export interface WebSearchDependencies {
  searcher: WebSearcher;
}

/**
 * Web を検索する（F-35）。
 *
 * 結果の解釈も要約もここではしない。エージェントが読んで判断する材料を
 * そのまま返す。**LLM に副作用を持たせない**（INV-3）ので、検索という
 * 外部呼び出しは決定的なコードのこの経路に閉じる。
 */
export async function searchWeb(
  deps: WebSearchDependencies,
  input: { query: string },
): Promise<WebSearchResult[]> {
  const query = input.query.trim();
  if (query === '') {
    throw new Error('検索クエリが空です。');
  }
  return deps.searcher.search({ query, limit: SEARCH_LIMIT });
}
