import { maskSecrets } from '../domain/ops.ts';
import type {
  WikiHit,
  WikiPage,
  WikiSource,
} from '../domain/ports/wiki-source.ts';

export interface WikiDependencies {
  wiki: WikiSource;
}

/** 1 回の検索で返す件数。多いと文脈を食う。 */
export const MAX_WIKI_HITS = 10;
/** 1 ページぶんとして返す文字数。超えたら切って、続きがあることを言う。 */
export const MAX_WIKI_PAGE_CHARS = 8_000;
export const DEFAULT_WIKI_LOCALE = 'ja';

export async function searchWiki(
  deps: WikiDependencies,
  query: string,
): Promise<{ hits: WikiHit[]; omitted: number }> {
  const hits = await deps.wiki.search(query);
  return {
    hits: hits.slice(0, MAX_WIKI_HITS),
    omitted: Math.max(0, hits.length - MAX_WIKI_HITS),
  };
}

export interface WikiPageText {
  page: WikiPage;
  /** 秘密を伏せて、長すぎれば切った本文。 */
  text: string;
  truncated: boolean;
}

export async function readWikiPage(
  deps: WikiDependencies,
  path: string,
  locale = DEFAULT_WIKI_LOCALE,
): Promise<WikiPageText | undefined> {
  const page = await deps.wiki.read(path, locale);
  if (!page) return undefined;
  // 切る前に伏せる（切れ目で秘密の一部だけが残らないように）。
  const masked = maskSecrets(page.content);
  const truncated = masked.length > MAX_WIKI_PAGE_CHARS;
  return {
    page,
    text: truncated ? masked.slice(0, MAX_WIKI_PAGE_CHARS) : masked,
    truncated,
  };
}
