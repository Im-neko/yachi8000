import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJevReactionClassifier } from './jev-reaction-classifier.ts';

const classifier = createJevReactionClassifier({ apiKey: 'test-key' });

/** 実物が返す形（`legend` と `probabilities` は使わないので省いてある）。 */
const ANSWER = {
  model: 'jev-1.13.0',
  answers: {
    expression: { type: 'choice', choice: 'happy', confidence: 0.88 },
    intensity: { type: 'score', score: 1.4, confidence: 0.71 },
    gesture: { type: 'choice', choice: 'nod', confidence: 0.82 },
  },
  usage: { input_tokens: 644, output_tokens: 89 },
};

function respondWith(body: unknown, init: ResponseInit = {}) {
  return vi.fn(
    async (_url: string, _init: RequestInit): Promise<Response> =>
      new Response(JSON.stringify(body), init),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createJevReactionClassifier', () => {
  it('文面を state の 1 項目に入れて投げ、判断を返す', async () => {
    const fetchMock = respondWith(ANSWER);
    vi.stubGlobal('fetch', fetchMock);

    const judgement = await classifier.classify('やりました。');

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    // **指示と文面を混ぜない**（絶対ルール 6）。文面は state の中だけ。
    expect(body.state).toEqual({ 発話: 'やりました。' });
    expect(JSON.stringify(body.questions)).not.toContain('やりました');
    // 閾値を実測に合わせているので、モデルは固定で呼ぶ。
    expect(body.model).toBe('jev-1.13.0');
    expect(judgement).toEqual({
      expression: {
        expression: 'happy',
        confidence: 0.88,
        intensity: 1.4,
        intensityConfidence: 0.71,
      },
      gesture: { label: 'nod', confidence: 0.82 },
    });
  });

  it('形が違えば投げる（黙って素の顔に倒さない）', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith({ model: 'jev-1.13.0', answers: { expression: {} } }),
    );

    await expect(classifier.classify('やりました。')).rejects.toThrow();
  });

  it('エラー応答は投げる', async () => {
    vi.stubGlobal('fetch', respondWith({ error: 'nope' }, { status: 401 }));

    await expect(classifier.classify('やりました。')).rejects.toThrow('401');
  });
});
