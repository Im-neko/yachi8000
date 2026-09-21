import type { ExpressionJudgement } from '../expression.ts';

/**
 * 発話の文面から「どう反応するか」をもらう口（F-24, F-25）。
 *
 * **表情と身振りを 1 回で聞く。** 判断を頼む先（Jev）は 1 リクエストで
 * 複数の問いを評価できるので、分けて呼ぶ理由がない —— 文面を 2 回渡すのは
 * 料金も時間も倍になるうえ、**同じ発話に食い違う判断が返りうる。**
 *
 * **返ってくるのはラベルと確信度だけ。** 実際に何をどれくらい出すかは
 * `domain/expression.ts` と `domain/gesture.ts` の規則で決める（絶対ルール 3）。
 *
 * **落ちることは普通に起こる**（外部 API・時間切れ）。呼び出し側は例外を
 * 受けて素の顔で進める —— 反応が付かないことは会話を止める理由にならない。
 */
export interface ReactionJudgement {
  expression: ExpressionJudgement;
  /**
   * 身振り。**語彙に無いラベルや `none` も普通に返る**ので、写すのは
   * `toGesture()` の仕事。
   */
  gesture: {
    label: string;
    confidence: number;
  };
}

export interface ReactionClassifier {
  classify(text: string): Promise<ReactionJudgement>;
}
