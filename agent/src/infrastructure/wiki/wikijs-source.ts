import * as v from 'valibot';
import type {
  WikiEditor,
  WikiHit,
  WikiPage,
  WikiPageDraft,
  WikiReplacement,
  WikiSource,
} from '../../domain/ports/wiki-source.ts';

const REQUEST_TIMEOUT_MS = 15_000;
/** Wiki.js が、ページが無いときに返す文言（HTTP 200 の GraphQL エラー）。 */
const PAGE_NOT_FOUND = 'This page does not exist.';

export interface CreateWikiJsClientInput {
  /** Wiki.js のベース URL（`/graphql` の手前まで）。 */
  baseUrl: string;
  /** API キー。書き込みの権限があれば書ける。 */
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

const PageFields = {
  path: v.string(),
  title: v.string(),
  description: v.string(),
  locale: v.string(),
  content: v.string(),
  updatedAt: v.string(),
};

const PageSchema = v.object({
  pages: v.object({ singleByPath: v.object(PageFields) }),
});

/** 書き換えるときに、元の設定をそのまま送り返すために要るもの。 */
const EditablePageSchema = v.object({
  pages: v.object({
    singleByPath: v.object({
      ...PageFields,
      id: v.number(),
      editor: v.string(),
      isPublished: v.boolean(),
      isPrivate: v.boolean(),
      tags: v.array(v.object({ tag: v.string() })),
    }),
  }),
});

const WriteResultSchema = v.object({
  responseResult: v.object({
    succeeded: v.boolean(),
    message: v.nullish(v.string()),
  }),
});

const CreatedSchema = v.object({
  pages: v.object({ create: WriteResultSchema }),
});

const UpdatedSchema = v.object({
  pages: v.object({ update: WriteResultSchema }),
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

const READ_EDITABLE = `query($path: String!, $locale: String!) {
  pages { singleByPath(path: $path, locale: $locale) {
    id path title description locale content updatedAt
    editor isPublished isPrivate tags { tag }
  } }
}`;

const CREATE = `mutation($content: String!, $description: String!, $locale: String!, $path: String!, $title: String!) {
  pages { create(
    content: $content, description: $description, editor: "markdown",
    isPublished: true, isPrivate: false, locale: $locale, path: $path,
    tags: [], title: $title
  ) { responseResult { succeeded message } } }
}`;

const UPDATE = `mutation($id: Int!, $content: String!, $description: String!, $editor: String!, $isPrivate: Boolean!, $isPublished: Boolean!, $locale: String!, $path: String!, $tags: [String]!, $title: String!) {
  pages { update(
    id: $id, content: $content, description: $description, editor: $editor,
    isPrivate: $isPrivate, isPublished: $isPublished, locale: $locale,
    path: $path, tags: $tags, title: $title
  ) { responseResult { succeeded message } } }
}`;

/** Wiki.js の GraphQL API を読み書きする（F-55, F-56）。 */
export function createWikiJsClient(
  input: CreateWikiJsClientInput,
): WikiSource & WikiEditor {
  const endpoint = `${input.baseUrl.replace(/\/$/, '')}/graphql`;

  async function post(
    label: string,
    document: string,
    variables: Record<string, unknown>,
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

  async function query<T extends v.GenericSchema>(
    label: string,
    document: string,
    variables: Record<string, unknown>,
    schema: T,
  ): Promise<v.InferOutput<T> | undefined> {
    const body = await post(label, document, variables);
    const error = errorMessage(body);
    if (error === PAGE_NOT_FOUND) return undefined;
    if (error) throw new Error(`${label}に失敗しました: ${error}`);
    return dataOf(label, schema, body);
  }

  /** 書き込みの結果。`succeeded` が偽なら、Wiki.js の理由をそのまま添えて投げる。 */
  function assertWritten(
    label: string,
    result: v.InferOutput<typeof WriteResultSchema>,
  ): void {
    if (!result.responseResult.succeeded) {
      throw new Error(
        `${label}に失敗しました: ${result.responseResult.message ?? '理由は返らなかった'}`,
      );
    }
  }

  async function readPage(path: string, locale: string) {
    return (
      await query('wiki のページの取得', READ, { path, locale }, PageSchema)
    )?.pages.singleByPath;
  }

  return {
    async search(text): Promise<WikiHit[]> {
      const data = await query(
        'wiki の検索',
        SEARCH,
        { query: text },
        SearchSchema,
      );
      return data?.pages.search.results ?? [];
    },

    read: readPage,

    async create(draft: WikiPageDraft): Promise<WikiPage> {
      if (await readPage(draft.path, draft.locale)) {
        throw new Error(
          `wiki に ${draft.path} のページがすでにあります（上書きはしません）。直すなら read_wiki_page で読んでから update_wiki_page を使ってください。`,
        );
      }
      const created = await query(
        'wiki のページの作成',
        CREATE,
        { ...draft },
        CreatedSchema,
      );
      if (!created) throw new Error('wiki のページの作成の応答が空でした');
      assertWritten('wiki のページの作成', created.pages.create);

      // 書けたことは、読み直して確かめる（応答の自己申告だけを信じない）。
      const page = await readPage(draft.path, draft.locale);
      if (!page) {
        throw new Error(
          `wiki のページの作成は成功と返りましたが、${draft.path} を読み直せませんでした`,
        );
      }
      return page;
    },

    async replaceContent(replacement: WikiReplacement): Promise<WikiPage> {
      const current = (
        await query(
          'wiki のページの取得',
          READ_EDITABLE,
          { path: replacement.path, locale: replacement.locale },
          EditablePageSchema,
        )
      )?.pages.singleByPath;
      if (!current) {
        throw new Error(
          `wiki に ${replacement.path} のページがありません。新しく作るなら create_wiki_page を使ってください。`,
        );
      }
      if (current.updatedAt !== replacement.expectedUpdatedAt) {
        throw new Error(
          `${replacement.path} は読んだあとに更新されています（読んだとき ${replacement.expectedUpdatedAt}、いま ${current.updatedAt}）。read_wiki_page で読み直してから、直し直してください。`,
        );
      }
      const updated = await query(
        'wiki のページの更新',
        UPDATE,
        {
          id: current.id,
          content: replacement.content,
          description: current.description,
          editor: current.editor,
          isPrivate: current.isPrivate,
          isPublished: current.isPublished,
          locale: current.locale,
          path: current.path,
          tags: current.tags.map((t) => t.tag),
          title: current.title,
        },
        UpdatedSchema,
      );
      if (!updated) throw new Error('wiki のページの更新の応答が空でした');
      assertWritten('wiki のページの更新', updated.pages.update);

      const page = await readPage(replacement.path, replacement.locale);
      if (!page || page.content.trimEnd() !== replacement.content.trimEnd()) {
        throw new Error(
          `wiki のページの更新は成功と返りましたが、${replacement.path} の本文が書いた内容と一致しません`,
        );
      }
      return page;
    },
  };
}
