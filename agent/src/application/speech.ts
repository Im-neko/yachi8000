import type { SpeechSynthesizer } from '../domain/ports/speech-synthesizer.ts';
import type { VoiceOutput } from '../domain/ports/voice-output.ts';
import { type SpeechPriority, splitIntoSentences } from '../domain/speech.ts';
import {
  createSpeechQueue,
  type QueuedSentence,
} from '../domain/speech-queue.ts';

/**
 * 溜められる文の上限（Q-06）。1 文あたり数秒なので、200 文で 10 分前後。
 * これを超えるほど積まれている時点で、読み上げても意味のある鮮度ではない。
 */
const QUEUE_CAPACITY = 200;

export interface SpeechDependencies {
  synthesizer: SpeechSynthesizer;
  voice: VoiceOutput;
  /** 破棄・失敗を表に出すためのログ。握りつぶさない。 */
  log: {
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
    debug(context: Record<string, unknown>, message: string): void;
  };
}

export interface SpeakInput {
  text: string;
  priority: SpeechPriority;
}

export interface SpeechService {
  /**
   * 読み上げを予約する。合成も再生も待たない。
   *
   * 発話させたい側（会話の応答・通知・将来のリマインダー）は**必ずここを通す**。
   * 再生経路を増やすと順序が非決定になる（INV-5）。
   */
  speak(input: SpeakInput): void;
  /** キューに残っている文の数。状態表示とテスト用。 */
  pending(): number;
}

/**
 * 発話の単一経路（INV-5）。
 *
 * 文単位に分割して 1 文ずつ合成・再生し、次の文はキューの先頭を取り直して
 * 決める。これにより通知は「再生中の文の切れ目」で割り込む（Q-05 → (b)）。
 * 再生中に次の文を先読み合成して、文の間の無音を詰める（D-11）。
 */
export function createSpeechService(deps: SpeechDependencies): SpeechService {
  const queue = createSpeechQueue(QUEUE_CAPACITY);
  let draining = false;

  /** 先読み。取り出す文が変わったら捨てる（通知に割り込まれた場合）。 */
  let prefetch:
    | { sentence: QueuedSentence; pcm: Promise<Uint8Array> }
    | undefined;

  function synthesize(sentence: QueuedSentence): Promise<Uint8Array> {
    return deps.synthesizer
      .synthesize(sentence.text)
      .then((speech) => speech.pcm);
  }

  function takePcm(sentence: QueuedSentence): Promise<Uint8Array> {
    if (prefetch && prefetch.sentence === sentence) {
      const { pcm } = prefetch;
      prefetch = undefined;
      return pcm;
    }
    // 先読みしていたのは別の文だった（= 割り込まれた）。結果は捨てる。
    if (prefetch) {
      prefetch.pcm.catch(() => undefined);
      prefetch = undefined;
    }
    return synthesize(sentence);
  }

  function startPrefetch(): void {
    const next = queue.peek();
    if (!next) return;
    const pcm = synthesize(next);
    pcm.catch(() => undefined);
    prefetch = { sentence: next, pcm };
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      for (let sentence = queue.take(); sentence; sentence = queue.take()) {
        // 再生中に VC から切れたら、残りは読まない。遅れて届く読み上げには
        // 価値がないうえ、接続が無いまま再生すると player が止まる。
        if (!deps.voice.current()) {
          const dropped = queue.clear() + 1;
          deps.log.warn(
            { dropped },
            'Left the voice channel — dropped the pending speech',
          );
          return;
        }

        try {
          const pcm = await takePcm(sentence);
          startPrefetch();
          await deps.voice.play(pcm);
        } catch (error) {
          // 1 文の失敗で残りを捨てない。落とした事実は必ず出す。
          deps.log.error(
            { err: error, priority: sentence.priority },
            'Failed to speak a sentence',
          );
        }
      }
    } finally {
      prefetch = undefined;
      draining = false;
    }
  }

  return {
    speak(input) {
      const sentences = splitIntoSentences(input.text);
      if (sentences.length === 0) return;

      if (!queue.enqueue({ priority: input.priority, sentences })) {
        deps.log.warn(
          {
            priority: input.priority,
            sentences: sentences.length,
            pending: queue.size(),
          },
          'Speech queue is full — dropped the utterance',
        );
        return;
      }

      deps.log.debug(
        { priority: input.priority, sentences: sentences.length },
        'Queued an utterance',
      );
      drain().catch((error) => {
        deps.log.error({ err: error }, 'Speech drain loop crashed');
      });
    },

    pending: () => queue.size(),
  };
}
