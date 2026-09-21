import { SPEECH_PRIORITIES, type SpeechPriority } from './speech.ts';
import type { SpeechOrigin } from './speech-audience.ts';

/** キューに載っている 1 文。同一性で「取り出す予定だった文」を識別する。 */
export interface QueuedSentence {
  readonly priority: SpeechPriority;
  /** 投入順。優先度が同じならこの順に読む（「たまたま速かった方が先」にしない）。 */
  readonly seq: number;
  readonly text: string;
  /**
   * どこから来た発話か。**取り出すたびに出口を選び直す**ために持ち歩く
   * （→ D-40）。積んでいる間に VC から抜けることも、ブラウザが開くこともある。
   */
  readonly origin: SpeechOrigin;
}

export interface SpeechRequest {
  readonly priority: SpeechPriority;
  readonly sentences: readonly string[];
  readonly origin: SpeechOrigin;
}

export interface SpeechQueue {
  /** 載せられたら true。上限を超えて破棄したら false（呼び出し側が WARN を出す）。 */
  enqueue(request: SpeechRequest): boolean;
  /** 次に読む 1 文を取り出す。 */
  take(): QueuedSentence | undefined;
  /** 次に読む 1 文を覗く。`take()` と同じオブジェクトを返す。 */
  peek(): QueuedSentence | undefined;
  /** 残りを全部捨てて、捨てた数を返す。 */
  clear(): number;
  size(): number;
}

/**
 * 優先度付き再生キュー（F-17, INV-5）。
 *
 * リマインダーと通知は会話の応答より先に出る。ただし**再生中の文は切らない**（Q-05 → (b)）。
 * 再生ループが 1 文ずつ取り出すので、割り込みは「次の文を通知に譲る」形で
 * 自然に実現される。追加の打ち切り機構は要らない。
 *
 * 短時間に通知が殺到した場合は**全部読む**（Q-06）。ただし無制限に積むと
 * 数時間分の読み上げが溜まるので上限を設け、超えた分は破棄する。
 * 破棄は黙って行わない（呼び出し側が WARN を出す）。
 */
export function createSpeechQueue(capacity: number): SpeechQueue {
  const buckets: Record<SpeechPriority, QueuedSentence[]> = {
    reminder: [],
    notification: [],
    reply: [],
  };
  let nextSeq = 0;

  function size(): number {
    let total = 0;
    for (const priority of SPEECH_PRIORITIES) total += buckets[priority].length;
    return total;
  }

  function head(): QueuedSentence | undefined {
    for (const priority of SPEECH_PRIORITIES) {
      const first = buckets[priority][0];
      if (first) return first;
    }
    return undefined;
  }

  return {
    enqueue(request) {
      if (request.sentences.length === 0) return true;
      if (size() + request.sentences.length > capacity) return false;

      const seq = nextSeq++;
      for (const text of request.sentences) {
        buckets[request.priority].push({
          priority: request.priority,
          seq,
          text,
          origin: request.origin,
        });
      }
      return true;
    },

    take() {
      for (const priority of SPEECH_PRIORITIES) {
        const bucket = buckets[priority];
        if (bucket.length > 0) return bucket.shift();
      }
      return undefined;
    },

    peek: head,

    clear() {
      const dropped = size();
      for (const priority of SPEECH_PRIORITIES) buckets[priority].length = 0;
      return dropped;
    },

    size,
  };
}
