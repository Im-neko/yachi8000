import * as v from 'valibot';
import type {
  WikiHit,
  WikiPage,
  WikiSource,
} from '../../domain/ports/wiki-source.ts';

const REQUEST_TIMEOUT_MS = 15_000;
/** Wiki.js が、ページが無いときに返す文言（HTTP 200 の GraphQL エラー）。 */
const PAGE_NOT_FOUND = 'This page does not exist.';

export interface CreateWikiJsSourceInput {
  /** Wiki.js のベース URL（`/graphql` の手前まで）。 */
  baseUrl: string;
  /** 読み取りにしか使わない API キー。 */
  apiKey: string;
}

const HitSchema = v.object({
  path: v.string(),
  title: v.string(),
  description: v.string(),
  locale: v.string(),
});

const SearchSchema = v.object({
  pages: v.object({
    search: v.object({ results: v.array(HitSchema) }),
  }),
});

const PageSchema = v.object({
  pages: v.object({
    singleByPath: v.object({
      path: v.string(),
      title: v.string(),
      description: v.string(),
      locale: v.string(),
      content: v.string(),
      updatedAt: v.string(),
    }),
  }),
});

const ErrorsSchema = v.object({
  errors: v.pipe(v.array(v.object({ message: v.string() })), v.minLength(1)),
});

const SEARCH = `query($query: String!) {
  pages { search(query: $query) { results { path title description locale } } }
}`;

const READ = `query($path: String!, $locale: String!) {
  pages { singleByPath(path: $path, locale: $locale) {
    path title description locale content updatedAt
  } }
}`;

/** Wiki.js の GraphQL API を読む（F-55）。 */
export function createWikiJsSource(input: CreateWikiJsSourceInput): WikiSource {
  const endpoint = `${input.baseUrl.replace(/\/$/, '')}/graphql`;

  async function post(
    label: string,
    document: string,
    variables: Record<string, string>,
  ): Promise<unknown> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({ query: document, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`${label}に失敗しました（HTTP ${response.status}）`);
    }
    return response.json();
  }

  /** GraphQL のエラーは HTTP 200 で返る。握りつぶさず投げる。 */
  function errorMessage(body: unknown): string | undefined {
    const parsed = v.safeParse(ErrorsSchema, body);
    return parsed.success ? parsed.output.errors[0]?.message : undefined;
  }

  function dataOf<T extends v.GenericSchema>(
    label: string,
    schema: T,
    body: unknown,
  ): v.InferOutput<T> {
    const data = (body as { data?: unknown } | null)?.data;
    const parsed = v.safeParse(schema, data);
    if (!parsed.success) {
      throw new Error(
        `${label}の応答を解釈できませんでした: ${v.summarize(parsed.issues)}`,
      );
    }
    return parsed.output;
  }

  return {
    async search(text): Promise<WikiHit[]> {
      const body = await post('wiki の検索', SEARCH, { query: text });
      const error = errorMessage(body);
      if (error) throw new Error(`wiki の検索に失敗しました: ${error}`);
      return dataOf('wiki の検索', SearchSchema, body).pages.search.results;
    },

    async read(path, locale): Promise<WikiPage | undefined> {
      const body = await post('wiki のページの取得', READ, { path, locale });
      const error = errorMessage(body);
      if (error === PAGE_NOT_FOUND) return undefined;
      if (error) {
        throw new Error(`wiki のページの取得に失敗しました: ${error}`);
      }
      return dataOf('wiki のページの取得', PageSchema, body).pages.singleByPath;
    },
  };
}
