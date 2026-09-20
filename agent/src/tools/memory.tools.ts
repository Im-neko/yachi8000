import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
  forgetMemory,
  listMemories,
  recallMemories,
  rememberFact,
} from '../application/memory.ts';
import { memoryDependencies } from '../composition-root.ts';
import type { MemoryRecord } from '../domain/memory.ts';
import type { SpeakerId } from '../domain/speaker.ts';

export interface MemoryToolsContext {
  /**
   * 誰の発言に紐づく記憶か（F-05）。分からなければ undefined。
   *
   * **分離の鍵ではない**（→ D-35）。保存時に帰属として残すだけで、想起は
   * 既定で全体から引く。
   */
  speakerId: SpeakerId | undefined;
}

function formatRecordedAt(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Tokyo',
  }).format(new Date(iso));
}

function formatRecord(record: MemoryRecord): string {
  return `- [${record.id}] ${formatRecordedAt(record.recordedAt)}: ${record.content}`;
}

/**
 * 長期記憶の読み書き（F-30）。
 *
 * 会話履歴は Flue の自動圧縮で落ちていくので、覚えておくべき事実は
 * `remember_fact` を明示的に呼ばないと消える。逆に、毎ターン自動で
 * 書き出すことはしない —— 何でも溜める置き場にすると想起が効かなくなる。
 *
 * **話しかけてくる相手そのものについては、こちらではなくプロフィール**
 * （F-05, `person.tools.ts`）。ここは話題に出る第三者を含む事実の置き場で、
 * 検索して引くもの。プロフィールは毎ターン必ず載るもの。
 */
export function createMemoryTools(ctx: MemoryToolsContext) {
  const remember = defineTool({
    name: 'remember_fact',
    description:
      '後の会話でも覚えておくべき事実を長期記憶に保存します。' +
      '利用者の好み・人間関係・繰り返し出てくる事情など、会話が流れても失いたくない情報に使ってください。' +
      '会話の一時的な文脈（今日の予定の相談など）は保存しません。' +
      '保存前に recall_memories で似た記憶が無いか確認してください。',
    input: v.object({
      content: v.pipe(v.string(), v.minLength(1)),
    }),
    async run({ data }) {
      const record = await rememberFact(memoryDependencies, {
        content: data.content,
        ...(ctx.speakerId === undefined ? {} : { speakerId: ctx.speakerId }),
      });
      return `覚えました: ${record.content}`;
    },
  });

  const recall = defineTool({
    name: 'recall_memories',
    description:
      '長期記憶を意味検索します。過去に覚えたことを思い出す必要があるときに使ってください。' +
      '既定では全員ぶんの記憶から探します。' +
      'only_this_person を true にすると、**今話している相手が言ったこと**だけに絞ります —— ' +
      '「私が前に言ったやつ」のように、その人自身の発言だと分かっているときにだけ使ってください。',
    input: v.object({
      query: v.pipe(v.string(), v.minLength(1)),
      only_this_person: v.optional(v.boolean()),
    }),
    async run({ data }) {
      const hits = await recallMemories(memoryDependencies, {
        query: data.query,
        ...(data.only_this_person && ctx.speakerId !== undefined
          ? { speakerId: ctx.speakerId }
          : {}),
      });
      if (hits.length === 0) return '関連する記憶は見つかりませんでした。';
      return hits
        .map((hit) => `${formatRecord(hit)} (類似度 ${hit.score.toFixed(3)})`)
        .join('\n');
    },
  });

  const list = defineTool({
    name: 'list_memories',
    description:
      '長期記憶を新しい順に一覧します。「何を覚えている？」と聞かれたときや、削除対象の ID を調べるときに使ってください。',
    input: v.object({}),
    async run() {
      const records = await listMemories(memoryDependencies);
      if (records.length === 0) return 'まだ何も覚えていません。';
      return records.map(formatRecord).join('\n');
    },
  });

  const forget = defineTool({
    name: 'forget_memory',
    description:
      '長期記憶を 1 件削除します。ID は list_memories / recall_memories が返す角括弧の中の値です。' +
      '利用者から明示的に依頼されたときだけ使ってください。',
    input: v.object({
      id: v.pipe(v.string(), v.uuid()),
    }),
    async run({ data }) {
      const removed = await forgetMemory(memoryDependencies, data.id);
      return removed
        ? `記憶 ${data.id} を削除しました。`
        : `記憶 ${data.id} は見つかりませんでした。`;
    },
  });

  return [remember, recall, list, forget];
}
