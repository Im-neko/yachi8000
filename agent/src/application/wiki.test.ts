import { describe, expect, it } from 'vitest';
import type { WikiHit, WikiSource } from '../domain/ports/wiki-source.ts';
import {
  MAX_WIKI_HITS,
  MAX_WIKI_PAGE_CHARS,
  readWikiPage,
  searchWiki,
} from './wiki.ts';

const hit = (n: number): WikiHit => ({
  path: `p/${n}`,
  title: `t${n}`,
  description: '',
  locale: 'ja',
});

function wikiOf(overrides: Partial<WikiSource> = {}): WikiSource {
  return {
    search: async () => [],
    read: async () => undefined,
    ...overrides,
  };
}

describe('searchWiki', () => {
  it('件数に上限を掛け、載せなかった数を返す', async () => {
    const wiki = wikiOf({
      search: async () => Array.from({ length: 13 }, (_, i) => hit(i)),
    });

    const result = await searchWiki({ wiki }, 'x');

    expect(result.hits).toHaveLength(MAX_WIKI_HITS);
    expect(result.omitted).toBe(3);
  });
});

describe('readWikiPage', () => {
  const page = (content: string) => ({
    ...hit(1),
    content,
    updatedAt: '2026-10-17T00:00:00.000Z',
  });

  it('秘密を伏せて返す', async () => {
    const wiki = wikiOf({
      read: async () => page('token: Bearer abcdef0123456789xyz'),
    });

    const result = await readWikiPage({ wiki }, 'p/1');

    expect(result?.text).not.toContain('abcdef0123456789xyz');
  });

  it('長すぎれば切って、切ったことを返す', async () => {
    const wiki = wikiOf({
      read: async () => page('あ'.repeat(MAX_WIKI_PAGE_CHARS + 50)),
    });

    const result = await readWikiPage({ wiki }, 'p/1');

    expect(result?.text).toHaveLength(MAX_WIKI_PAGE_CHARS);
    expect(result?.truncated).toBe(true);
  });

  it('ページが無ければ undefined。ロケールは ja が既定', async () => {
    const seen: string[] = [];
    const wiki = wikiOf({
      read: async (_path, locale) => {
        seen.push(locale);
        return undefined;
      },
    });

    await expect(readWikiPage({ wiki }, 'no/such')).resolves.toBeUndefined();
    expect(seen).toEqual(['ja']);
  });
});
