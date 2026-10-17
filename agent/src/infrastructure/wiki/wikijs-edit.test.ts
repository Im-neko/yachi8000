import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWikiJsClient } from './wikijs-source.ts';

const client = createWikiJsClient({
  baseUrl: 'http://wiki.example',
  apiKey: 'test-key',
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const notFound = () =>
  json({ errors: [{ message: 'This page does not exist.' }] });
const createdOk = () =>
  json({
    data: { pages: { create: { responseResult: { succeeded: true } } } },
  });
const updatedOk = () =>
  json({
    data: { pages: { update: { responseResult: { succeeded: true } } } },
  });

const page = (content: string, updatedAt = '2026-10-17T00:00:00.000Z') => ({
  path: 'infra/memo',
  title: 'メモ',
  description: '説明',
  locale: 'ja',
  content,
  updatedAt,
});

const editable = (content: string, updatedAt?: string) =>
  json({
    data: {
      pages: {
        singleByPath: {
          ...page(content, updatedAt),
          id: 7,
          editor: 'markdown',
          isPublished: true,
          isPrivate: false,
          tags: [{ tag: 'infra' }],
        },
      },
    },
  });

const read = (content: string, updatedAt?: string) =>
  json({ data: { pages: { singleByPath: page(content, updatedAt) } } });

function variablesOf(fetchSpy: ReturnType<typeof vi.spyOn>, call: number) {
  const init = fetchSpy.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)).variables;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('create', () => {
  it('同じ path が無ければ作り、読み直して確かめてから返す', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(createdOk())
      .mockResolvedValueOnce(read('# 本文'));

    const created = await client.create({
      path: 'infra/memo',
      locale: 'ja',
      title: 'メモ',
      description: '説明',
      content: '# 本文',
    });

    expect(created.content).toBe('# 本文');
    expect(variablesOf(fetchSpy, 1)).toMatchObject({
      path: 'infra/memo',
      title: 'メモ',
      content: '# 本文',
    });
  });

  it('すでにあれば上書きせずに投げる（作成の問い合わせは送らない）', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(read('既存'));

    await expect(
      client.create({
        path: 'infra/memo',
        locale: 'ja',
        title: 't',
        description: '',
        content: 'x',
      }),
    ).rejects.toThrow(/すでにあります/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('Wiki.js が失敗と返したら、その理由を添えて投げる', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(
        json({
          data: {
            pages: {
              create: {
                responseResult: {
                  succeeded: false,
                  message: '権限がありません',
                },
              },
            },
          },
        }),
      );

    await expect(
      client.create({
        path: 'a/b',
        locale: 'ja',
        title: 't',
        description: '',
        content: 'x',
      }),
    ).rejects.toThrow(/権限がありません/);
  });

  it('成功と返っても読み直せなければ、書けたことにしない', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(createdOk())
      .mockResolvedValueOnce(notFound());

    await expect(
      client.create({
        path: 'a/b',
        locale: 'ja',
        title: 't',
        description: '',
        content: 'x',
      }),
    ).rejects.toThrow(/読み直せませんでした/);
  });
});

describe('replaceContent', () => {
  it('読んだ版のままなら、タイトル・タグ・公開設定を残して本文だけ置き換える', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(editable('古い'))
      .mockResolvedValueOnce(updatedOk())
      .mockResolvedValueOnce(read('新しい\n'));

    const result = await client.replaceContent({
      path: 'infra/memo',
      locale: 'ja',
      content: '新しい',
      expectedUpdatedAt: '2026-10-17T00:00:00.000Z',
    });

    expect(result.content).toBe('新しい\n');
    expect(variablesOf(fetchSpy, 1)).toEqual({
      id: 7,
      content: '新しい',
      description: '説明',
      editor: 'markdown',
      isPrivate: false,
      isPublished: true,
      locale: 'ja',
      path: 'infra/memo',
      tags: ['infra'],
      title: 'メモ',
    });
  });

  it('読んだあとに更新されていたら、書かずに投げる', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(editable('古い', '2026-10-17T05:00:00.000Z'));

    await expect(
      client.replaceContent({
        path: 'infra/memo',
        locale: 'ja',
        content: '新しい',
        expectedUpdatedAt: '2026-10-17T00:00:00.000Z',
      }),
    ).rejects.toThrow(/読んだあとに更新されています/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('ページが無ければ投げる。書いたはずの本文と違えば成功と返っても投げる', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(notFound());
    await expect(
      client.replaceContent({
        path: 'no/such',
        locale: 'ja',
        content: 'x',
        expectedUpdatedAt: 't',
      }),
    ).rejects.toThrow(/ページがありません/);

    fetchSpy
      .mockResolvedValueOnce(editable('古い'))
      .mockResolvedValueOnce(updatedOk())
      .mockResolvedValueOnce(read('古いまま'));
    await expect(
      client.replaceContent({
        path: 'infra/memo',
        locale: 'ja',
        content: '新しい',
        expectedUpdatedAt: '2026-10-17T00:00:00.000Z',
      }),
    ).rejects.toThrow(/一致しません/);
  });
});
