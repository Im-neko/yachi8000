import { beforeEach, describe, expect, it } from 'vitest';
import type { AvatarEvent } from '../domain/avatar-event.ts';
import {
  type ExpressionJudgement,
  MAX_WEIGHT,
  MIN_HOLD_MS,
} from '../domain/expression.ts';
import {
  type AvatarGesture,
  MIN_GESTURE_CONFIDENCE,
  MIN_GESTURE_INTERVAL_MS,
} from '../domain/gesture.ts';
import type { ReactionJudgement } from '../domain/ports/reaction-classifier.ts';
import { createReactionService, type ReactionService } from './reaction.ts';

const HAPPY_FACE: ExpressionJudgement = {
  expression: 'happy',
  confidence: 0.9,
  intensity: 2,
  intensityConfidence: 0.9,
};

/** 身振り無し。**大半の発話はこれ**（→ D-42 の 3）。 */
const NO_GESTURE = { label: 'none', confidence: 0.9 };

const HAPPY: ReactionJudgement = {
  expression: HAPPY_FACE,
  gesture: NO_GESTURE,
};

const SAD: ReactionJudgement = {
  expression: { ...HAPPY_FACE, expression: 'sad' },
  gesture: NO_GESTURE,
};

interface Harness {
  service: ReactionService;
  published: AvatarEvent[];
  warnings: string[];
  asked: string[];
  watching: number;
  now: number;
  /** 次に返す判断。`Error` を入れると投げる。 */
  answer: ReactionJudgement | Error;
  /** 素材が置いてある身振り。 */
  available: AvatarGesture[];
  /** 投げた判断が届くまで待つ（fire-and-forget なので明示的に流す）。 */
  settle(): Promise<void>;
}

function createHarness(): Harness {
  const harness: Harness = {
    service: undefined as unknown as ReactionService,
    published: [],
    warnings: [],
    asked: [],
    watching: 1,
    now: 10_000,
    answer: HAPPY,
    available: ['nod', 'wave'],
    settle: async () => {
      await Promise.resolve();
      await Promise.resolve();
    },
  };

  harness.service = createReactionService({
    classifier: {
      classify: async (text: string) => {
        harness.asked.push(text);
        if (harness.answer instanceof Error) throw harness.answer;
        return harness.answer;
      },
    },
    avatar: { publish: (event: AvatarEvent) => harness.published.push(event) },
    watching: () => harness.watching,
    availableGestures: () => harness.available,
    now: () => harness.now,
    log: {
      warn: (_context: Record<string, unknown>, message: string) =>
        harness.warnings.push(message),
      debug: () => undefined,
    },
  });

  return harness;
}

describe('createReactionService', () => {
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

describe('createReactionService（身振り）', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  function judgeGesture(label: string, confidence: number): ReactionJudgement {
    return { expression: HAPPY_FACE, gesture: { label, confidence } };
  }

  it('確信のある身振りを流す', async () => {
    h.answer = judgeGesture('nod', 0.9);
    h.service.forUtterance('そうですね。');
    await h.settle();

    expect(h.published).toContainEqual({ kind: 'gesture', gesture: 'nod' });
  });

  // 身振りの外れは目に刺さる（→ D-42 の 3）。迷ったら出さない。
  it('確信度が足りなければ出さない', async () => {
    h.answer = judgeGesture('nod', MIN_GESTURE_CONFIDENCE - 0.01);
    h.service.forUtterance('そうですね。');
    await h.settle();

    expect(h.published.some((e) => e.kind === 'gesture')).toBe(false);
  });

  // 出せないものを流すと、ブラウザ側で無音のまま失敗する。
  it('素材が置かれていない身振りは流さない', async () => {
    h.answer = judgeGesture('bow', 1);
    h.service.forUtterance('すみません。');
    await h.settle();

    expect(h.published.some((e) => e.kind === 'gesture')).toBe(false);
  });

  it('続けざまには出さない', async () => {
    h.answer = judgeGesture('nod', 0.9);
    h.service.forUtterance('そうですね。');
    await h.settle();

    h.now += MIN_GESTURE_INTERVAL_MS - 1;
    h.service.forUtterance('はい。');
    await h.settle();

    expect(h.published.filter((e) => e.kind === 'gesture')).toHaveLength(1);

    h.now += 2;
    h.service.forUtterance('はい。');
    await h.settle();

    expect(h.published.filter((e) => e.kind === 'gesture')).toHaveLength(2);
  });
});
