import type { ExpressionJudgement } from '../expression.ts';

/**
 * 発話の文面から表情の判断をもらう口（F-24）。
 *
 * **返ってくるのはラベルと確信度だけ。** 表情そのものを決めるのは
 * `domain/expression.ts` の規則で、この口の実装（外部モデル）には
 * 「どう見せるか」を持たせない（絶対ルール 3）。
 *
 * **落ちることは普通に起こる**（外部 API・時間切れ）。呼び出し側は例外を
 * 受けて素の顔で進める —— 表情が付かないことは会話を止める理由にならない。
 */
export interface ExpressionClassifier {
  classify(text: string): Promise<ExpressionJudgement>;
}
