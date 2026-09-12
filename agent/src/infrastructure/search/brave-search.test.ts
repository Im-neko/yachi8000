import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBraveSearcher } from './brave-search.ts';

const searcher = createBraveSearcher({ apiKey: 'test-key' });

/** 呼ばれた URL を記録したいので、引数の型を URL に固定した fetch の代役。 */
function respondWith(body: unknown, init: ResponseInit = {}) {
  return vi.fn(async (_url: URL): Promise<Response> => {
    return new Response(JSON.stringify(body), init);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createBraveSearcher', () => {
  it('クエリと件数を渡し、必要な 3 項目に畳む', async () => {
    const fetchMock = respondWith({
      web: {
        results: [
          {
            title: 'Flue Framework',
            url: 'https://flueframework.com/',
            description: 'Flue の <strong>公式</strong>サイト',
          },
        ],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await searcher.search({ query: 'flue', limit: 5 });

    const request = fetchMock.mock.calls[0]?.[0];
    expect(request?.searchParams.get('q')).toBe('flue');
    expect(request?.searchParams.get('count')).toBe('5');
    expect(results).toEqual([
      {
        title: 'Flue Framework',
        url: 'https://flueframework.com/',
        // 強調タグは読み上げにも表示にも邪魔なので落とす。
        snippet: 'Flue の 公式サイト',
      },
    ]);
  });

  // Brave は実際にアポストロフィを 16 進の数値参照で返してくる。名前付きだけ
  // 処理すると、生の &#x27; がそのまま読み上げられる。
  it('HTML 実体参照を文字へ戻す（数値参照も含む）', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith({
        web: {
          results: [
            {
              title: 'Flue',
              url: 'https://flueframework.com/',
              description:
                'Build with Flue&#x27;s harness &amp; <em>ship</em> &#39;it&#39; &lt;now&gt;',
            },
          ],
        },
      }),
    );

    const [result] = await searcher.search({ query: 'x', limit: 5 });
    expect(result?.snippet).toBe("Build with Flue's harness & ship 'it' <now>");
  });

  it('二重に解釈しない（&amp;#39; はそのまま &#39; になる）', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith({
        web: {
          results: [
            {
              title: 't',
              url: 'https://example.com/',
              description: '&amp;#39;',
            },
          ],
        },
      }),
    );
    const [result] = await searcher.search({ query: 'x', limit: 5 });
    expect(result?.snippet).toBe('&#39;');
  });

  it('件数の上限を超える応答は切り詰める', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith({
        web: {
          results: Array.from({ length: 10 }, (_, i) => ({
            title: `t${i}`,
            url: `https://example.com/${i}`,
            description: 'd',
          })),
        },
      }),
    );
    expect(await searcher.search({ query: 'x', limit: 3 })).toHaveLength(3);
  });

  it('結果が無い応答は空配列になる（web ごと無いこともある）', async () => {
    vi.stubGlobal('fetch', respondWith({}));
    expect(await searcher.search({ query: 'x', limit: 5 })).toEqual([]);
  });

  // キーが切れているのを「見つからなかった」に倒すと、モデルは「無かった」と
  // 答えてしまう。失敗は失敗として上げる。
  it('HTTP エラーは投げる', async () => {
    vi.stubGlobal('fetch', respondWith({}, { status: 401 }));
    await expect(searcher.search({ query: 'x', limit: 5 })).rejects.toThrow(
      /Web 検索に失敗しました: 401/,
    );
  });

  it('形の違う応答は投げる（黙って空にしない）', async () => {
    vi.stubGlobal('fetch', respondWith({ web: { results: [{ title: 1 }] } }));
    await expect(searcher.search({ query: 'x', limit: 5 })).rejects.toThrow(
      /解釈できませんでした/,
    );
  });
});
