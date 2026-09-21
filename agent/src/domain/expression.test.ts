import { describe, expect, it } from 'vitest';
import {
  type ExpressionCue,
  MAX_WEIGHT,
  MIN_CONFIDENCE,
  MIN_HOLD_MS,
  MIN_WEIGHT,
  NEUTRAL_CUE,
  shouldHoldPrevious,
  toExpressionCue,
} from './expression.ts';

const CONFIDENT = {
  expression: 'happy',
  confidence: 0.9,
  intensity: 2,
  intensityConfidence: 0.9,
};

describe('toExpressionCue', () => {
  it('確信のある判断は、その表情を強めに出す', () => {
    expect(toExpressionCue(CONFIDENT)).toEqual({
      expression: 'happy',
      weight: MAX_WEIGHT,
    });
  });

  // 何でもない相槌で顔が動かないようにする（→ D-41 の 3）。
  it('確信度が足りなければ素の顔', () => {
    expect(
      toExpressionCue({ ...CONFIDENT, confidence: MIN_CONFIDENCE - 0.01 }),
    ).toEqual(NEUTRAL_CUE);
  });

  it('プリセットに無い表情は素の顔', () => {
    expect(toExpressionCue({ ...CONFIDENT, expression: 'excited' })).toEqual(
      NEUTRAL_CUE,
    );
  });

  it('neutral は重み 0 で返す（「素の顔を強く出す」は無い）', () => {
    expect(toExpressionCue({ ...CONFIDENT, expression: 'neutral' })).toEqual(
      NEUTRAL_CUE,
    );
  });

  it('弱い判断でも、出すと決めたら下限まではっきり出す', () => {
    expect(toExpressionCue({ ...CONFIDENT, intensity: 0 })).toEqual({
      expression: 'happy',
      weight: MIN_WEIGHT,
    });
  });

  // 「強く出すかどうか分からない」は「強く出す」ではない。
  it('強さの確信が無いときは真ん中へ寄せる', () => {
    const cue = toExpressionCue({
      ...CONFIDENT,
      intensity: 2,
      intensityConfidence: 0.2,
    });
    expect(cue.weight).toBeGreaterThan(MIN_WEIGHT);
    expect(cue.weight).toBeLessThan(MAX_WEIGHT);
  });
});

describe('shouldHoldPrevious', () => {
  const previous = {
    cue: { expression: 'happy', weight: 0.5 } as ExpressionCue,
    at: 1_000,
  };

  it('直前に別の表情を出していたら、短い間は飛ばさない', () => {
    const next: ExpressionCue = { expression: 'sad', weight: 0.5 };
    expect(shouldHoldPrevious(previous, next, 1_000 + MIN_HOLD_MS - 1)).toBe(
      true,
    );
    expect(shouldHoldPrevious(previous, next, 1_000 + MIN_HOLD_MS)).toBe(false);
  });

  it('同じ表情の重みの変化は止めない', () => {
    expect(
      shouldHoldPrevious(previous, { expression: 'happy', weight: 0.3 }, 1_100),
    ).toBe(false);
  });

  // 落ち着く方向は速くてよい。止めるのは「別の感情へ飛ぶ」ことだけ。
  it('素の顔へ戻すのは止めない', () => {
    expect(shouldHoldPrevious(previous, NEUTRAL_CUE, 1_100)).toBe(false);
  });

  // 発話ごとに素の顔へ戻す（読み終わり）ので、ここで止めると次の発話の
  // 表情がまるごと消える。
  it('素の顔からの立ち上がりは止めない', () => {
    expect(
      shouldHoldPrevious(
        { cue: NEUTRAL_CUE, at: 1_000 },
        { expression: 'sad', weight: 0.5 },
        1_100,
      ),
    ).toBe(false);
  });

  it('直前が無ければ止めない', () => {
    expect(
      shouldHoldPrevious(undefined, { expression: 'sad', weight: 0.5 }, 1_100),
    ).toBe(false);
  });
});
