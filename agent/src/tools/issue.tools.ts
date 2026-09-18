import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { createIssueFromMessage } from '../application/issue.ts';
import { issueDependencies } from '../composition-root.ts';
import type { IssueSource } from '../domain/issue.ts';

export interface IssueToolsContext {
  /** 起票先を決めるチャンネル。スレッドではなく親チャンネルの ID。 */
  channelId: string;
  /** 出典になる投稿（スレッドの元投稿）。 */
  source: IssueSource;
  sourceMessageId: string;
  /** メンションで言われたこと。Issue 本文の「依頼」に載る。 */
  instruction: string;
}

/**
 * スレッドの元投稿を Issue にする（F-37）。
 *
 * **配線されるのはスレッドの中だけ**（→ D-33）。スレッドの外では
 * 「どの投稿を Issue にするのか」が決まらず、会話のどこかを勝手に
 * 出典にしてしまう。出典が決まらない起票はしない。
 *
 * 出典ブロック（Discord のパーマリンク＋引用）は application 側が前置する。
 * ここで description に書いているのは、モデルに任せる部分——タイトル・
 * 本文・ラベル——だけ。
 */
export function createIssueTools(ctx: IssueToolsContext) {
  const create = defineTool({
    name: 'create_github_issue',
    description:
      'このスレッドの元になった投稿を GitHub の Issue にします。' +
      '「Issue にして」「起票して」と頼まれたときに使ってください。' +
      'title は何をするかが一目で分かる日本語の一文にします。' +
      'body には、何を確かめるのか・何が壊れているのか・判断の材料・完了条件を書いてください。' +
      '元投稿の引用と出典リンクは自動で付くので、body に繰り返さないでください。' +
      'labels はリポジトリに存在するものだけを送ります（存在しないラベルを送ると起票が失敗します）。' +
      '未検証のアイデアには idea、実装済みの機能の不具合には bug を付けてください。',
    input: v.object({
      title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      body: v.pipe(v.string(), v.minLength(1), v.maxLength(30000)),
      labels: v.optional(v.array(v.pipe(v.string(), v.minLength(1))), []),
    }),
    async run({ data }) {
      const created = await createIssueFromMessage(issueDependencies, {
        channelId: ctx.channelId,
        source: ctx.source,
        sourceMessageId: ctx.sourceMessageId,
        title: data.title,
        body: data.body,
        labels: data.labels,
        instruction: ctx.instruction,
      });
      return `Issue を立てました: #${created.number} ${created.url}`;
    },
  });

  return [create];
}
