import { beforeEach, describe, expect, it } from 'vitest';
import type { AvatarEvent } from '../domain/avatar-event.ts';
import {
  type ExpressionJudgement,
  MAX_WEIGHT,
  MIN_HOLD_MS,
} from '../domain/expression.ts';
import {
  createExpressionService,
  type ExpressionService,
} from './expression.ts';

const HAPPY: ExpressionJudgement = {
  expression: 'happy',
  confidence: 0.9,
  intensity: 2,
  intensityConfidence: 0.9,
};

const SAD: ExpressionJudgement = { ...HAPPY, expression: 'sad' };

interface Harness {
  service: ExpressionService;
  published: AvatarEvent[];
  warnings: string[];
  asked: string[];
  watching: number;
  now: number;
  /** 次に返す判断。`Error` を入れると投げる。 */
  answer: ExpressionJudgement | Error;
  /** 投げた判断が届くまで待つ（fire-and-forget なので明示的に流す）。 */
  settle(): Promise<void>;
}

function createHarness(): Harness {
  const harness: Harness = {
    service: undefined as unknown as ExpressionService,
    published: [],
    warnings: [],
    asked: [],
    watching: 1,
    now: 10_000,
    answer: HAPPY,
    settle: async () => {
      await Promise.resolve();
      await Promise.resolve();
    },
  };

  harness.service = createExpressionService({
    classifier: {
      classify: async (text) => {
        harness.asked.push(text);
        if (harness.answer instanceof Error) throw harness.answer;
        return harness.answer;
      },
    },
    avatar: { publish: (event) => harness.published.push(event) },
    watching: () => harness.watching,
    now: () => harness.now,
    log: {
      warn: (_context, message) => harness.warnings.push(message),
      debug: () => undefined,
    },
  });

  return harness;
}

describe('createExpressionService', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it('発話ごとに 1 回判断を頼み、表情を流す', async () => {
    h.service.forUtterance('やりました。');
    await h.settle();

    expect(h.asked).toEqual(['やりました。']);
    expect(h.published).toEqual([
      { kind: 'expression', expression: 'happy', weight: MAX_WEIGHT },
    ]);
  });

  // 消音のタブでも顔は見えるので、判定は「見ている人がいるか」。
  it('誰も見ていなければ頼まない', async () => {
    h.watching = 0;
    h.service.forUtterance('やりました。');
    await h.settle();

    expect(h.asked).toEqual([]);
    expect(h.published).toEqual([]);
  });

  it('判断できなければ素の顔にして WARN を出す（INV-7）', async () => {
    h.answer = new Error('timeout');
    h.service.forUtterance('やりました。');
    await h.settle();

    expect(h.warnings).toHaveLength(1);
    expect(h.published).toEqual([
      { kind: 'expression', expression: 'neutral', weight: 0 },
    ]);
  });

  it('読み終わったら素の顔へ戻す', async () => {
    h.service.forUtterance('やりました。');
    await h.settle();
    h.service.relax();

    expect(h.published.at(-1)).toEqual({
      kind: 'expression',
      expression: 'neutral',
      weight: 0,
    });
  });

  it('素の顔のままなら、戻すイベントは出さない', () => {
    h.service.relax();
    h.service.relax();

    expect(h.published).toEqual([]);
  });

  // 短い応答が続いたときに顔がぱたぱた切り替わらないようにする（D-41 の 3）。
  it('直前と違う感情へは、しばらく飛ばない', async () => {
    h.service.forUtterance('やりました。');
    await h.settle();

    h.answer = SAD;
    h.now += MIN_HOLD_MS - 1;
    h.service.forUtterance('だめでした。');
    await h.settle();

    expect(h.published).toHaveLength(1);

    h.now += 2;
    h.service.forUtterance('だめでした。');
    await h.settle();

    expect(h.published.at(-1)).toEqual({
      kind: 'expression',
      expression: 'sad',
      weight: MAX_WEIGHT,
    });
  });

  // 読み上げのほうが短いと、判断が返るころには終わっている。
  it('素の顔へ戻したあとに届いた判断は捨てる', async () => {
    h.service.forUtterance('やりました。');
    h.service.relax();
    await h.settle();

    expect(h.published).toEqual([]);
  });
});
