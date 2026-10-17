import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
  DEFAULT_WIKI_LOCALE,
  MAX_WIKI_HITS,
  MAX_WIKI_PAGE_CHARS,
  readWikiPage,
  searchWiki,
  type WikiDependencies,
} from '../application/wiki.ts';
import { maskSecrets } from '../domain/ops.ts';
import { fence } from './data-fence.ts';

const WIKI_ORIGIN =
  '社内 wiki のページ（誰でも書き換えられる外部由来のデータ）';

/**
 * 社内 wiki を引く道具（F-55）。**読むだけ。**
 * 取れなかったときは投げる —— 「載っていない」と答えさせない。
 */
export function createWikiTools(deps: WikiDependencies) {
  const searchWikiTool = defineTool({
    name: 'search_wiki',
    description:
      '社内 wiki のページをタイトル・説明・本文から検索します（最大 ' +
      `${MAX_WIKI_HITS} 件）。自宅の機器・ネットワーク・既知の IP アドレス・手順など、` +
      '「うちの○○は?」と聞かれたときに使います。見つけたページは read_wiki_page で読みます。',
    input: v.object({
      query: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    }),
    async run({ data }) {
      const { hits, omitted } = await searchWiki(deps, data.query);
      if (hits.length === 0) {
        return `「${data.query}」に当たるページはありませんでした。言葉を変えて探してください。`;
      }
      const lines = hits.map(
        (h) =>
          `- ${h.path}（${h.locale}）「${h.title}」${h.description ? ` — ${h.description}` : ''}`,
      );
      if (omitted > 0) lines.push(`…ほか ${omitted} 件`);
      return fence(
        `wiki の検索結果（${data.query}）`,
        maskSecrets(lines.join('\n')),
        WIKI_ORIGIN,
      );
    },
  });

  const readWikiPageTool = defineTool({
    name: 'read_wiki_page',
    description:
      '社内 wiki のページを path で読みます（例: infra/network/known-ips）。' +
      `長いページは先頭の ${MAX_WIKI_PAGE_CHARS} 文字までです。`,
    input: v.object({
      path: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
      locale: v.optional(v.pipe(v.string(), v.minLength(2), v.maxLength(10))),
    }),
    async run({ data }) {
      const result = await readWikiPage(
        deps,
        data.path.replace(/^\/+/, ''),
        data.locale ?? DEFAULT_WIKI_LOCALE,
      );
      if (!result) {
        return `wiki に ${data.path} のページはありませんでした。search_wiki で path を確かめてください。`;
      }
      return fence(
        `wiki のページ ${result.page.path}「${result.page.title}」（更新 ${result.page.updatedAt}）`,
        [
          result.text,
          ...(result.truncated
            ? [
                `…（長いため先頭の ${MAX_WIKI_PAGE_CHARS} 文字まで。` +
                  '全文を読めていないので、update_wiki_page では書き換えず、足すだけなら append_to_wiki_page を使うこと）',
              ]
            : []),
        ].join('\n'),
        WIKI_ORIGIN,
      );
    },
  });

  return [searchWikiTool, readWikiPageTool];
}
