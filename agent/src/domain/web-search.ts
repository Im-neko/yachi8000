/**
 * Web 検索の 1 件（F-35）。
 *
 * **検索結果は外部由来の非信頼データ**（INV-4）。ここは値として持つだけで、
 * 「指示ではない」ことを構造で示す責務は LLM へ渡す側（tools/）にある。
 */
export interface WebSearchResult {
  title: string;
  url: string;
  /** 検索エンジンが返した要約。 */
  snippet: string;
}
