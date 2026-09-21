/**
 * 発話に合わせた表情の選択（F-24, D-41）。
 *
 * **判断そのものは外（Jev）でするが、表情を決めるのはここ。** 返ってくるのは
 * ラベルと確信度だけで、「どの表情をどれくらい強く出すか」は決定的な規則で
 * 決める（絶対ルール 3）。確信の無い判断で顔を動かさないのも、動かしすぎない
 * のも、ここの責任。
 */

import { AVATAR_EXPRESSIONS, type AvatarExpression } from './avatar.ts';

/**
 * **表情の一覧は `avatar.ts` の 1 つだけ。** 人が設定で選ぶ待機時の表情と、
 * 発話ごとに選ぶ表情は同じプリセット集合で、二重に持つと必ず片方だけ
 * 増えて食い違う。口形（`aa` 等）とは別の層に乗る（→ D-41 の 2）。
 */

/** 外の分類器が返したもの。`intensity` は 0〜2（3 段階の期待値）。 */
export interface ExpressionJudgement {
  readonly expression: string;
  readonly confidence: number;
  readonly intensity: number;
  readonly intensityConfidence: number;
}

/** 実際に出す表情。`weight` が 0 なら「素の顔」。 */
export interface ExpressionCue {
  readonly expression: AvatarExpression;
  readonly weight: number;
}

/** 素の顔。判断できなかったとき・自信が無いときはこれ。 */
export const NEUTRAL_CUE: ExpressionCue = { expression: 'neutral', weight: 0 };

/**
 * これ未満の確信度では顔を動かさない。
 *
 * **実測で決めた値**（2026-09-21、6 例。表は D-41 の 4）。返ってくる確信度は
 * 山が 2 つに割れていて、**感情を選んだときは 0.75〜1.00、感情が無い発話では
 * `neutral` を 0.75 で選ぶ**。その間（0.6 付近）には何も落ちてこなかったので、
 * 空いているところに置いてある。
 *
 * 下げると、何でもない相槌で顔が動く。上げると、観測した中でいちばん弱い
 * 正しい判断（0.75）に近づきすぎる。
 *
 * **`intensityConfidence` の足切りにも同じ値を使う**（下の `toExpressionCue`）。
 * 「強く出すかどうか分からない」ときに真ん中へ寄せる境目で、こちらは
 * 0.26〜0.79 と散らばっていた。
 */
export const MIN_CONFIDENCE = 0.6;

/**
 * 出す強さの上限。**1.0 にしない** —— 感情の表情が口形（F-21）を消すため。
 *
 * VRM 1.0 の表情は `overrideMouth` を宣言でき、`blend` なら **口形の重みが
 * `1 - 感情の重み` 倍になる**（three-vrm の `_calculateWeightMultipliers`）。
 * デプロイ済みのモデルでは `happy` / `sad` / `surprised` が `blend` だった
 * （実測）。つまり 0.7 で笑わせると、喋っている口が 3 割しか動かない。
 *
 * 0.4 は、話している間に待機の表情へ掛けている値（`web/src/stage.ts`）と
 * 同じ —— 同じ理由で選ばれた値なので揃えてある。**口形は 6 割残る。**
 */
export const MAX_WEIGHT = 0.4;

/** 出すと決めたときの下限。弱すぎると「動いていない」と区別が付かない。 */
export const MIN_WEIGHT = 0.2;

/**
 * **同じ顔を保つ最短時間**（ミリ秒）。
 *
 * 発話ごとに判断するので、短い応答が続くと顔がぱたぱた切り替わる。
 * 分類の取り違えが起きたときも、見え方はこの「ちらつき」になる。
 * **変える速さに天井を付けるのは、精度とは別の守り**（→ D-41 の 3）。
 */
export const MIN_HOLD_MS = 3_000;

function isAvatarExpression(value: string): value is AvatarExpression {
  return (AVATAR_EXPRESSIONS as readonly string[]).includes(value);
}

/**
 * 判断を表情に写す。**写せないもの・自信の無いものは素の顔**。
 *
 * `intensity` は 0〜2 で返る（3 段階の期待値）。0〜1 に潰したうえで、
 * 下限と上限で挟む。**強さの確信度が低いときは真ん中に寄せる** ——
 * 「強く出すかどうか分からない」は「強く出す」ではない。
 */
export function toExpressionCue(judgement: ExpressionJudgement): ExpressionCue {
  if (!isAvatarExpression(judgement.expression)) return NEUTRAL_CUE;
  if (judgement.expression === 'neutral') return NEUTRAL_CUE;
  if (judgement.confidence < MIN_CONFIDENCE) return NEUTRAL_CUE;

  const normalized = clamp(judgement.intensity / 2, 0, 1);
  const centered =
    judgement.intensityConfidence < MIN_CONFIDENCE
      ? (normalized + 0.5) / 2
      : normalized;

  return {
    expression: judgement.expression,
    weight: round(MIN_WEIGHT + (MAX_WEIGHT - MIN_WEIGHT) * centered),
  };
}

/**
 * 直前の表情を保つか。**保つなら新しい表情は捨てる**（→ D-41 の 3）。
 *
 * 素の顔へ戻すことは止めない —— 止めるのは「別の感情へ飛ぶ」ことだけで、
 * 落ち着く方向は速くてよい。
 */
export function shouldHoldPrevious(
  previous: { readonly cue: ExpressionCue; readonly at: number } | undefined,
  next: ExpressionCue,
  now: number,
  minHoldMs: number = MIN_HOLD_MS,
): boolean {
  if (previous === undefined) return false;
  // 素の顔からは、いつでも動かしてよい。止めたいのは**感情どうしの飛び移り**
  // だけで、「何も出していない」からの立ち上がりはちらつきに見えない。
  if (previous.cue.weight === 0) return false;
  if (next.expression === previous.cue.expression) return false;
  if (next.weight === 0) return false;
  return now - previous.at < minHoldMs;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
