import * as v from 'valibot';
import { AVATAR_GESTURES, NO_GESTURE } from '../../domain/gesture.ts';
import type {
  ReactionClassifier,
  ReactionJudgement,
} from '../../domain/ports/reaction-classifier.ts';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/**
 * **モデルは固定する。** 閾値（`MIN_CONFIDENCE`）を実測に合わせているので、
 * `jev-latest` で中身が変わると顔の出方が黙って変わる。上げるときは
 * 確信度を測り直してから（→ D-41 の 4）。
 */
const MODEL = 'jev-1.13.0';

/**
 * 待つ上限。
 *
 * **実測は 2 本目以降が 249〜568 ms、1 本目だけが 1212 ms**（2026-09-21）。
 * 温まる前の 1 回が飛び抜けるので、**そこを切ると「再起動後の最初の発話
 * だけ顔が動かない」**という、いちばん気付きにくい形で壊れる。
 *
 * 長く待つことの代償は小さい —— 読み上げは待っていないし、間に合わなかった
 * 判断は呼び出し側が捨てる（`relax()` の世代）。
 */
const TIMEOUT_MS = 2_000;

/**
 * 聞くこと。**指示文はこちら側に固定で持つ。**
 *
 * Jev は `state` を敵対的入力として扱わない（公式が明記する弱点）。
 * 通知本文や検索結果は非信頼データ（絶対ルール 6）なので、**文面は state の
 * 1 フィールドに閉じ込め、指示と混ぜない。** 返るのはラベルだけなので、
 * 仮に操作されても被害は「表情が不適切に変わる」に留まる（→ D-41 の 5）。
 */
const QUESTIONS = {
  expression: {
    type: 'choice',
    instructions:
      'この発話をしているキャラクターの表情として最も自然なもの。話し相手ではなく、話している側の表情を選ぶ。',
    criteria: {
      neutral: '特に感情が乗っていない、淡々とした発話',
      happy: '嬉しい・楽しい・肯定的。うまくいったことを伝えている',
      angry: '怒り・強い不満・咎めている',
      sad: '悲しい・申し訳ない・残念に思っている',
      relaxed: '穏やか・安心している・落ち着いて受け止めている',
      surprised: '驚き・意外・慌てている',
    },
  },
  intensity: {
    type: 'score',
    instructions: 'その表情をどれくらい強く顔に出すか',
    criteria: ['ほとんど顔に出さない', 'はっきり分かる程度', '大きく顔に出す'],
  },
  /**
   * 身振り（F-25）。**同じリクエストに問いを足すだけ。**
   *
   * 入力は使い回しになり、出力は課金対象外なので**料金はほぼ変わらない**。
   * 応答時間も、複数問を 1 回で評価するモデルなので伸びない。
   *
   * **`none` を先頭に置き、説明でも「大半はこれ」と言い切る。** 身振りは
   * 外れの代償が大きいので、**迷ったら出さない**へ倒したい。
   */
  gesture: {
    type: 'choice',
    instructions:
      'この発話に自然に伴う身振りはどれか。大半の発話には身振りは伴わないので、はっきり当てはまるものが無ければ none を選ぶ。',
    criteria: {
      [NO_GESTURE]: '特に身振りを伴わない。淡々とした受け答え・説明・報告',
      nod: '頷く。同意する、了解する、相手の話を受け止める',
      tilt: '首をかしげる。疑問に思う、迷う、はっきりしない',
      wave: '手を振る。挨拶、呼びかけ、別れ',
      bow: 'お辞儀する。謝る、礼を言う',
      shrug: '肩をすくめる。分からない、どうしようもない',
      present: '手で示す。説明する、何かを指し示す、提示する',
    },
  },
} as const;

// **語彙のずれを起動時に落とす。** 説明の側だけ足して domain を直し忘れると、
// 「返ってくるが絶対に出ない身振り」が黙って生まれる。
const described = Object.keys(QUESTIONS.gesture.criteria);
for (const gesture of AVATAR_GESTURES) {
  if (!described.includes(gesture)) {
    throw new Error(
      `身振り ${gesture} の説明が Jev への問いにありません（domain/gesture.ts と揃えてください）。`,
    );
  }
}

/**
 * 使う部分だけを検証する。**形が違えば投げる** —— 黙って素の顔に倒すと、
 * API の仕様変更に気付かないまま「表情の付かないアバター」になる。
 */
const JevResponseSchema = v.object({
  model: v.string(),
  answers: v.object({
    expression: v.object({
      choice: v.string(),
      confidence: v.number(),
    }),
    intensity: v.object({
      /** 3 段階（0〜2）の期待値。0.49 のような小数で返る。 */
      score: v.number(),
      confidence: v.number(),
    }),
    gesture: v.object({
      choice: v.string(),
      confidence: v.number(),
    }),
  }),
});

export interface CreateJevClassifierInput {
  apiKey: string;
  /** 差し替え用。既定は実物のエンドポイント。 */
  endpoint?: string;
  timeoutMs?: number;
}

/**
 * Jev（TypeSafe System One）で表情と身振りを判断する（→ D-41, D-42）。
 *
 * テキスト生成をせず**型付きの判断だけ**返すモデルなので、
 * 「LLM に副作用を持たせない」（絶対ルール 3）と構造が噛み合う。
 * 1 リクエストで複数の質問を同時に評価でき、`state` は 1 回しか読まれない。
 */
export function createJevReactionClassifier(
  input: CreateJevClassifierInput,
): ReactionClassifier {
  const endpoint = input.endpoint ?? ENDPOINT;
  const timeoutMs = input.timeoutMs ?? TIMEOUT_MS;

  return {
    async classify(text: string): Promise<ReactionJudgement> {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          'content-type': 'application/json',
        },
        // **文面は state の 1 フィールドに閉じ込める。** 裸の文字列で渡すと
        // 「state 全体が指示」という読まれ方を誘う。
        body: JSON.stringify({
          model: MODEL,
          state: { 発話: text },
          questions: QUESTIONS,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(
          `Jev returned ${response.status} ${response.statusText}`,
        );
      }

      const body = v.parse(JevResponseSchema, await response.json());
      return {
        expression: {
          expression: body.answers.expression.choice,
          confidence: body.answers.expression.confidence,
          intensity: body.answers.intensity.score,
          intensityConfidence: body.answers.intensity.confidence,
        },
        gesture: {
          label: body.answers.gesture.choice,
          confidence: body.answers.gesture.confidence,
        },
      };
    },
  };
}
