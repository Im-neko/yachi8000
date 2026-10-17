import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
  appendToWikiPage,
  createWikiPage,
  MAX_WIKI_WRITE_CHARS,
  replaceWikiPage,
  type WikiEditDependencies,
} from '../application/wiki.ts';
import type { WikiPage } from '../domain/ports/wiki-source.ts';

const PathSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const ContentSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(MAX_WIKI_WRITE_CHARS),
);

function written(action: string, page: WikiPage): string {
  return `${action}: ${page.path}「${page.title}」（更新 ${page.updatedAt}）。wiki には変更の履歴が残ります。`;
}

/**
 * 社内 wiki へ書く道具（F-56）。
 *
 * **頼まれたときだけ使う。** 書いた内容を決めるのはモデルだが、path・本文・
 * 衝突は決定的なコードが確かめる（上書きしない・読んだ版でなければ書かない・
 * 秘密に見える文字列は書かない）。**消す道具は無い。**
 * 呼び出し側は、誰が頼んだか分かる会話にだけ配ること。
 */
export function createWikiEditTools(deps: WikiEditDependencies) {
  const create = defineTool({
    name: 'create_wiki_page',
    description:
      '社内 wiki に新しいページを作ります。**利用者に頼まれたときだけ**使います。' +
      '同じ path のページがあるときは作らずに失敗します（上書きしません）。' +
      'path は infra/network/known-ips のように / で階層を区切ります。' +
      '本文は Markdown。トークンやパスワードに見える文字列は書けません。',
    input: v.object({
      path: PathSchema,
      title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      description: v.optional(v.pipe(v.string(), v.maxLength(500)), ''),
      content: ContentSchema,
    }),
    async run({ data }) {
      const page = await createWikiPage(deps, data);
      return written('wiki にページを作りました', page);
    },
  });

  const append = defineTool({
    name: 'append_to_wiki_page',
    description:
      '社内 wiki の既存ページの末尾に、文章を足します。**利用者に頼まれたときだけ**使います。' +
      '既存の部分には触れないので、「メモを足して」「この IP を一覧に追記して」はこちらを使います。' +
      '足す前にそのページを read_wiki_page で読んで、何を足すか決めてください。',
    input: v.object({
      path: PathSchema,
      text: ContentSchema,
    }),
    async run({ data }) {
      const page = await appendToWikiPage(deps, data);
      return written('wiki のページに足しました', page);
    },
  });

  const update = defineTool({
    name: 'update_wiki_page',
    description:
      '社内 wiki の既存ページの本文を、全文で置き換えます。**利用者に頼まれたときだけ**使います。' +
      '**全文を read_wiki_page で読んだページにだけ**使い、expectedUpdatedAt には読んだときの更新日時を' +
      'そのまま渡します（読んだあとにページが変わっていたら、書かずに失敗します）。' +
      '途中までしか読めていないページや、足すだけの変更には append_to_wiki_page を使ってください。',
    input: v.object({
      path: PathSchema,
      content: ContentSchema,
      expectedUpdatedAt: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    }),
    async run({ data }) {
      const page = await replaceWikiPage(deps, data);
      return written('wiki のページを書き換えました', page);
    },
  });

  return [create, append, update];
}
