import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWikiJsSource } from './wikijs-source.ts';

const source = createWikiJsSource({
  baseUrl: 'http://wiki.example/',
  apiKey: 'test-key',
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const PAGE = {
  path: 'infra/network/known-ips',
  title: '既知のIP',
  description: '一覧',
  locale: 'ja',
  content: '# 既知のIP',
  updatedAt: '2026-10-17T13:34:20.111Z',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createWikiJsSource', () => {
  it('検索は GraphQL を POST し、認証ヘッダを付けてヒットを返す', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        data: {
          pages: {
            search: {
              results: [
                {
                  path: PAGE.path,
                  title: PAGE.title,
                  description: PAGE.description,
                  locale: 'ja',
                },
              ],
            },
          },
        },
      }),
    );

    const hits = await source.search('既知のIP');

    expect(hits).toEqual([
      {
        path: PAGE.path,
        title: PAGE.title,
        description: PAGE.description,
        locale: 'ja',
      },
    ]);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe('http://wiki.example/graphql');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key' });
    expect(JSON.parse(String(init?.body)).variables).toEqual({
      query: '既知のIP',
    });
  });

  it('ページを path で読む', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ data: { pages: { singleByPath: PAGE } } }),
    );

    await expect(source.read(PAGE.path, 'ja')).resolves.toEqual(PAGE);
  });

  it('ページが無いことだけは undefined で返す', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        errors: [{ message: 'This page does not exist.' }],
        data: { pages: { singleByPath: null } },
      }),
    );

    await expect(source.read('no/such', 'ja')).resolves.toBeUndefined();
  });

  it('それ以外のエラーは投げる（「載っていない」に倒さない）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      json({ errors: [{ message: 'Forbidden' }] }),
    );
    await expect(source.search('x')).rejects.toThrow(/Forbidden/);

    fetchSpy.mockResolvedValueOnce(json({}, 502));
    await expect(source.search('x')).rejects.toThrow(/HTTP 502/);

    fetchSpy.mockResolvedValueOnce(json({ data: { pages: {} } }));
    await expect(source.search('x')).rejects.toThrow(/解釈できませんでした/);
  });
});
