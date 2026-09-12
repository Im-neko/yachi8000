import * as v from 'valibot';
import type {
  WebSearcher,
  WebSearchQuery,
} from '../../domain/ports/web-search.ts';
import type { WebSearchResult } from '../../domain/web-search.ts';

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const SEARCH_TIMEOUT_MS = 10_000;

/**
 * 応答のうち、こちらが使う部分だけを検証する。
 *
 * `web` が無い応答もある（結果 0 件・ニュースだけのクエリ）ので optional に
 * しておく。**形が違うときは投げる** —— 黙って空配列に倒すと、API の仕様変更に
 * 気付かないまま「何も見つからない検索」になる。
 */
const BraveResponseSchema = v.object({
  web: v.optional(
    v.object({
      results: v.array(
        v.object({
          title: v.string(),
          url: v.string(),
          description: v.optional(v.string()),
        }),
      ),
    }),
  ),
});

const NAMED_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
};

/**
 * Brave の要約には一致箇所の `<strong>` と HTML 実体参照が入る。読み上げにも
 * Discord の表示にも邪魔なので、タグを落として参照を文字へ戻す。
 *
 * **数値参照（`&#39;` / `&#x27;`）も戻す。** Brave は実際にアポストロフィを
 * 16 進の数値参照で返してくるので、名前付きだけ処理すると生の `&#x27;` が
 * そのまま読み上げられる。
 */
function stripHtml(text: string): string {
  let result = text.replaceAll(/<[^>]*>/g, '');
  for (const [entity, character] of Object.entries(NAMED_ENTITIES)) {
    result = result.replaceAll(entity, character);
  }
  result = result.replaceAll(/&#(x[0-9a-f]+|\d+);/gi, (_match, code: string) =>
    String.fromCodePoint(
      code.toLowerCase().startsWith('x')
        ? Number.parseInt(code.slice(1), 16)
        : Number.parseInt(code, 10),
    ),
  );
  // `&amp;` は最後に戻す。先に戻すと `&amp;#39;` が二重に解釈される。
  return result.replaceAll('&amp;', '&').trim();
}

export interface CreateBraveSearcherInput {
  apiKey: string;
}

/**
 * Brave Search API による Web 検索（F-35, → D-27）。
 *
 * キー不要の DuckDuckGo は実測で使えなかった（HTML 版は Cloudflare に弾かれ、
 * 公式の Instant Answer API は Web 検索を返さない）。TLS フィンガープリントを
 * 偽装して通す手段は採らない（迂回・ハックの禁止）。
 */
export function createBraveSearcher(
  input: CreateBraveSearcherInput,
): WebSearcher {
  return {
    async search(query: WebSearchQuery): Promise<WebSearchResult[]> {
      const url = new URL(ENDPOINT);
      url.searchParams.set('q', query.query);
      url.searchParams.set('count', String(query.limit));

      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': input.apiKey,
        },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(
          `Web 検索に失敗しました: ${response.status} ${response.statusText}`,
        );
      }

      const parsed = v.safeParse(BraveResponseSchema, await response.json());
      if (!parsed.success) {
        throw new Error(
          `Web 検索の応答を解釈できませんでした: ${v.summarize(parsed.issues)}`,
        );
      }

      return (parsed.output.web?.results ?? [])
        .slice(0, query.limit)
        .map((result) => ({
          title: result.title,
          url: result.url,
          snippet: stripHtml(result.description ?? ''),
        }));
    },
  };
}
