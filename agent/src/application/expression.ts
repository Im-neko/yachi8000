import {
  type ExpressionCue,
  NEUTRAL_CUE,
  shouldHoldPrevious,
  toExpressionCue,
} from '../domain/expression.ts';
import type { AvatarEventPublisher } from '../domain/ports/avatar-event-publisher.ts';
import type { ExpressionClassifier } from '../domain/ports/expression-classifier.ts';

export interface ExpressionDependencies {
  classifier: ExpressionClassifier;
  /** アバターへ流す口。**投げっぱなし**（F-21 と同じ約束）。 */
  avatar: AvatarEventPublisher;
  /**
   * 見ている人の数。
   *
   * **「音を鳴らせるか」ではなく「見ているか」で数える**（→ D-40 と違う軸）。
   * 消音のタブでも顔は見えるので、出口の判定（`listeningBrowsers`）を
   * 流用すると、見ているのに顔だけ動かない。誰も見ていないなら外の
   * モデルを呼ぶ意味が無い（料金がかかる）。
   */
  watching(): number;
  now(): number;
  log: {
    warn(context: Record<string, unknown>, message: string): void;
    debug(context: Record<string, unknown>, message: string): void;
  };
}

export interface ExpressionService {
  /**
   * 発話 1 つぶんの表情を決めて流す（F-24）。**待たない。**
   *
   * 判断は外のモデル（Jev）へ投げるが、**読み上げはその返りを待たない** ——
   * 待つと声の出始めが判断のぶんだけ遅れる。表情は別のイベントとして
   * 後から届き、発話の途中で顔が変わる。
   */
  forUtterance(text: string): void;
  /**
   * 素の顔へ戻す。**読み上げが終わったときに呼ぶ。**
   *
   * 呼ばないと、最後の発話の顔がいつまでも残る（怒った顔のまま待機する）。
   */
  relax(): void;
}

/**
 * 発話に表情を付ける（F-24, D-41）。
 *
 * **判断させるだけで、何もさせない**（絶対ルール 3）。外のモデルが返すのは
 * ラベルと確信度で、そこから実際の顔を決めるのは `domain/expression.ts`。
 */
export function createExpressionService(
  deps: ExpressionDependencies,
): ExpressionService {
  let previous: { cue: ExpressionCue; at: number } | undefined;
  /**
   * 世代。**素の顔へ戻すたびに進める。**
   *
   * 短い発話だと、判断が返る前に読み上げが終わることがある。そのまま当てると
   * 「終わった発話の顔」が待機中に貼り付く。戻したあとに届いた判断は捨てる。
   */
  let generation = 0;

  function publish(cue: ExpressionCue): void {
    previous = { cue, at: deps.now() };
    deps.avatar.publish({
      kind: 'expression',
      expression: cue.expression,
      weight: cue.weight,
    });
  }

  return {
    forUtterance(text) {
      if (deps.watching() === 0) return;

      const era = generation;
      void deps.classifier
        .classify(text)
        .then((judgement) => {
          if (era !== generation) return;
          const cue = toExpressionCue(judgement);
          if (shouldHoldPrevious(previous, cue, deps.now())) {
            deps.log.debug(
              { expression: cue.expression },
              'Held the previous expression',
            );
            return;
          }
          publish(cue);
        })
        .catch((error: unknown) => {
          // 顔が付かなくても会話は続くので、これは意図した部分縮退。
          // **黙ってやらない**（INV-7）—— ログが唯一の手がかりになる。
          deps.log.warn(
            { err: error },
            'Failed to judge the expression — fell back to a neutral face',
          );
          if (era === generation) publish(NEUTRAL_CUE);
        });
    },

    relax() {
      generation++;
      if (previous === undefined || previous.cue.weight === 0) return;
      publish(NEUTRAL_CUE);
    },
  };
}
