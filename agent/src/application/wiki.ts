import { maskSecrets } from '../domain/ops.ts';
import type {
  WikiEditor,
  WikiHit,
  WikiPage,
  WikiSource,
} from '../domain/ports/wiki-source.ts';

export interface WikiDependencies {
  wiki: WikiSource;
}

export interface WikiEditDependencies extends WikiDependencies {
  editor: WikiEditor;
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

/** 書き込みの本文の上限。wiki のページとして常識的な大きさ。 */
export const MAX_WIKI_WRITE_CHARS = 50_000;
const MAX_WIKI_PATH_CHARS = 200;

/**
 * 書いてよい path か。階層は `/` で区切り、先頭と末尾の `/`・空の階層・`.` で始まる
 * 階層（`..` を含む）・空白や URL で意味を持つ文字（`?` `#` `%` `\`）は受けない。
 */
export function assertWritablePath(path: string): void {
  const invalid =
    path.length === 0 ||
    path.length > MAX_WIKI_PATH_CHARS ||
    /[\s\\?#%]/.test(path) ||
    path
      .split('/')
      .some((segment) => segment === '' || segment.startsWith('.'));
  if (invalid) {
    throw new Error(
      `wiki の path として使えません: ${path}（空白と ? # % \\ を含まず、階層は / 区切りで、空の階層や . で始まる階層は使えません）`,
    );
  }
}

function assertWritableContent(content: string): void {
  if (content.trim().length === 0) {
    throw new Error('本文が空です');
  }
  if (content.length > MAX_WIKI_WRITE_CHARS) {
    throw new Error(
      `本文が長すぎます（${content.length} 文字。上限は ${MAX_WIKI_WRITE_CHARS} 文字）`,
    );
  }
  // wiki は人が読み、このエージェント自身も後から読み返して答えに出す。
  // 一度書くと履歴にも残るので、秘密に見える文字列は書かない。
  if (maskSecrets(content) !== content) {
    throw new Error(
      '本文にトークンやパスワードに見える文字列が含まれているので、wiki には書きません。伏せるか、書かない形に直してください。',
    );
  }
}

export interface NewWikiPage {
  path: string;
  title: string;
  description: string;
  content: string;
  locale?: string;
}

export async function createWikiPage(
  deps: WikiEditDependencies,
  input: NewWikiPage,
): Promise<WikiPage> {
  assertWritablePath(input.path);
  assertWritableContent(input.content);
  if (input.title.trim().length === 0) throw new Error('タイトルが空です');
  return deps.editor.create({
    path: input.path,
    locale: input.locale ?? DEFAULT_WIKI_LOCALE,
    title: input.title,
    description: input.description,
    content: input.content,
  });
}

export interface WikiPageReplacement {
  path: string;
  content: string;
  /** 読んだときの `updatedAt`。 */
  expectedUpdatedAt: string;
  locale?: string;
}

export async function replaceWikiPage(
  deps: WikiEditDependencies,
  input: WikiPageReplacement,
): Promise<WikiPage> {
  assertWritablePath(input.path);
  assertWritableContent(input.content);
  return deps.editor.replaceContent({
    path: input.path,
    locale: input.locale ?? DEFAULT_WIKI_LOCALE,
    content: input.content,
    expectedUpdatedAt: input.expectedUpdatedAt,
  });
}

/**
 * 既存ページの末尾に足す。**全文を送り直さずに済む**ので、長くて途中までしか
 * 読めなかったページでも、既存の部分を壊さない。読んだ直後の版に足し、その間に
 * 変わっていれば書かずに投げる。
 */
export async function appendToWikiPage(
  deps: WikiEditDependencies,
  input: { path: string; text: string; locale?: string },
): Promise<WikiPage> {
  assertWritablePath(input.path);
  assertWritableContent(input.text);
  const locale = input.locale ?? DEFAULT_WIKI_LOCALE;
  const current = await deps.wiki.read(input.path, locale);
  if (!current) {
    throw new Error(
      `wiki に ${input.path} のページがありません。新しく作るなら create_wiki_page を使ってください。`,
    );
  }
  const content = `${current.content.trimEnd()}\n\n${input.text.trim()}\n`;
  if (content.length > MAX_WIKI_WRITE_CHARS) {
    throw new Error(
      `足すとページが長くなりすぎます（${content.length} 文字。上限は ${MAX_WIKI_WRITE_CHARS} 文字）`,
    );
  }
  return deps.editor.replaceContent({
    path: input.path,
    locale,
    content,
    expectedUpdatedAt: current.updatedAt,
  });
}
