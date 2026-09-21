import { describe, expect, it } from 'vitest';
import { createSpeechQueue } from './speech-queue.ts';

/** 出口の選択はここでは関心事ではない（→ domain/speech-audience.test.ts）。 */
const ORIGIN = { kind: 'conversation', guildId: 'g' } as const;

function drain(queue: ReturnType<typeof createSpeechQueue>): string[] {
  const out: string[] = [];
  for (let s = queue.take(); s; s = queue.take()) out.push(s.text);
  return out;
}

describe('createSpeechQueue', () => {
  it('同じ優先度なら投入順に読む', () => {
    const queue = createSpeechQueue(10);
    queue.enqueue({
      origin: ORIGIN,
      priority: 'reply',
      sentences: ['A1', 'A2'],
    });
    queue.enqueue({ origin: ORIGIN, priority: 'reply', sentences: ['B1'] });
    expect(drain(queue)).toEqual(['A1', 'A2', 'B1']);
  });

  it('通知は残りの応答より先に読む（文の切れ目で割り込む）', () => {
    const queue = createSpeechQueue(10);
    queue.enqueue({
      origin: ORIGIN,
      priority: 'reply',
      sentences: ['R1', 'R2', 'R3'],
    });
    expect(queue.take()?.text).toBe('R1'); // 再生中の 1 文は切らない
    queue.enqueue({
      origin: ORIGIN,
      priority: 'notification',
      sentences: ['N1'],
    });
    expect(drain(queue)).toEqual(['N1', 'R2', 'R3']);
  });

  it('割り込み中に確定した応答は、通知を読み終えてから読む', () => {
    const queue = createSpeechQueue(10);
    queue.enqueue({
      origin: ORIGIN,
      priority: 'notification',
      sentences: ['N1', 'N2'],
    });
    expect(queue.take()?.text).toBe('N1');
    queue.enqueue({ origin: ORIGIN, priority: 'reply', sentences: ['R1'] });
    expect(drain(queue)).toEqual(['N2', 'R1']);
  });

  it('リマインダーは通知より先に読む（利用者が時刻を指定したもの）', () => {
    const queue = createSpeechQueue(10);
    queue.enqueue({ origin: ORIGIN, priority: 'reply', sentences: ['R1'] });
    queue.enqueue({
      origin: ORIGIN,
      priority: 'notification',
      sentences: ['N1'],
    });
    queue.enqueue({ origin: ORIGIN, priority: 'reminder', sentences: ['M1'] });
    expect(drain(queue)).toEqual(['M1', 'N1', 'R1']);
  });

  it('リマインダーの割り込みも再生中の 1 文は切らない', () => {
    const queue = createSpeechQueue(10);
    queue.enqueue({
      origin: ORIGIN,
      priority: 'reply',
      sentences: ['R1', 'R2'],
    });
    expect(queue.take()?.text).toBe('R1');
    queue.enqueue({ origin: ORIGIN, priority: 'reminder', sentences: ['M1'] });
    expect(drain(queue)).toEqual(['M1', 'R2']);
  });

  it('上限を超える投入は丸ごと断る', () => {
    const queue = createSpeechQueue(3);
    expect(
      queue.enqueue({
        origin: ORIGIN,
        priority: 'reply',
        sentences: ['A', 'B'],
      }),
    ).toBe(true);
    expect(
      queue.enqueue({
        origin: ORIGIN,
        priority: 'reply',
        sentences: ['C', 'D'],
      }),
    ).toBe(false);
    expect(drain(queue)).toEqual(['A', 'B']);
  });

  it('peek は take と同じオブジェクトを返す（先読みの同一性判定に使う）', () => {
    const queue = createSpeechQueue(10);
    queue.enqueue({ origin: ORIGIN, priority: 'reply', sentences: ['A'] });
    expect(queue.peek()).toBe(queue.take());
  });

  it('clear は残りを捨てて件数を返す', () => {
    const queue = createSpeechQueue(10);
    queue.enqueue({ origin: ORIGIN, priority: 'reminder', sentences: ['M'] });
    queue.enqueue({
      origin: ORIGIN,
      priority: 'notification',
      sentences: ['N'],
    });
    queue.enqueue({
      origin: ORIGIN,
      priority: 'reply',
      sentences: ['R1', 'R2'],
    });
    expect(queue.clear()).toBe(4);
    expect(queue.size()).toBe(0);
  });
});
