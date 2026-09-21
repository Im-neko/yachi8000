import type { VisemeTimeline } from '../domain/lipsync.ts';
import type { AvatarEventPublisher } from '../domain/ports/avatar-event-publisher.ts';
import type { OutputAvailabilityProvider } from '../domain/ports/output-availability.ts';
import type { SpeechAudioStore } from '../domain/ports/speech-audio-store.ts';
import type { SpeechSynthesizer } from '../domain/ports/speech-synthesizer.ts';
import type { VoiceOutput } from '../domain/ports/voice-output.ts';
import {
  type SpeechPriority,
  splitIntoSentences,
  stripUrlsForSpeech,
} from '../domain/speech.ts';
import {
  hasNoTarget,
  type SpeechOrigin,
  type SpeechTargets,
  selectSpeechTargets,
} from '../domain/speech-audience.ts';
import {
  createSpeechQueue,
  type QueuedSentence,
} from '../domain/speech-queue.ts';
import type { ExpressionService } from './expression.ts';

/**
 * 溜められる文の上限（Q-06）。1 文あたり数秒なので、200 文で 10 分前後。
 * これを超えるほど積まれている時点で、読み上げても意味のある鮮度ではない。
 */
const QUEUE_CAPACITY = 200;

export interface SpeechDependencies {
  synthesizer: SpeechSynthesizer;
  voice: VoiceOutput;
  /** つながっている出口（→ D-40）。**出す先を決めるのはここだけ。** */
  outputs: OutputAvailabilityProvider;
  /**
   * 指定ミリ秒待つ。**ブラウザだけが聞いているときの歩調に使う。**
   *
   * VC があるときは `voice.play()` が再生の長さだけ待ってくれるが、
   * ブラウザは投げっぱなし（イベントを publish するだけ）なので、
   * 待つものが無いと全文が一瞬で流れてしまう。テストから差し替えられるよう
   * 注入する。
   */
  sleep(ms: number): Promise<void>;
  /** アバターへ流す口（F-21, F-22）。**投げっぱなしで、待たない。** */
  avatar: AvatarEventPublisher;
  /**
   * 発話に表情を付ける口（F-24）。**任意** —— 判断を頼む先（Jev）の鍵が
   * 無い環境では素の顔のまま動く。表情は会話を止める理由にならない。
   */
  expression?: ExpressionService;
  /** ブラウザが取りに来るまで音を置いておく場所（F-23）。 */
  audio: SpeechAudioStore;
  /** 「話している」の出どころ（F-22）。読み上げの区間と一致させる。 */
  presence: { beginSpeaking(): () => void };
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
  /** どこから来た発話か。出口の選択に使う（→ D-40）。 */
  origin: SpeechOrigin;
}

export interface SpeechService {
  /**
   * 読み上げを予約する。合成も再生も待たない。
   *
   * 発話させたい側（会話の応答・通知・リマインダー）は**必ずここを通す**。
   * 再生経路を増やすと順序が非決定になる（INV-5）。
   */
  speak(input: SpeakInput): void;
  /**
   * いまこの出どころの発話を受け取る出口があるか（→ D-40）。
   *
   * 通知とリマインダーが「読み上げられないならテキストへ回す」を決めるために
   * 使う。**状態は変わりうる**ので、再生の直前にもう一度判定する。
   */
  canSpeak(origin: SpeechOrigin): boolean;
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

  /** 合成の成果物。音と口形は**同じ合成から**来る（→ D-38 の 2）。 */
  interface Synthesized {
    pcm: Uint8Array;
    lipSync: VisemeTimeline;
  }

  /** 先読み。取り出す文が変わったら捨てる（通知に割り込まれた場合）。 */
  let prefetch:
    | { sentence: QueuedSentence; speech: Promise<Synthesized> }
    | undefined;

  function synthesize(sentence: QueuedSentence): Promise<Synthesized> {
    return deps.synthesizer.synthesize(sentence.text);
  }

  function takeSpeech(sentence: QueuedSentence): Promise<Synthesized> {
    if (prefetch && prefetch.sentence === sentence) {
      const { speech } = prefetch;
      prefetch = undefined;
      return speech;
    }
    // 先読みしていたのは別の文だった（= 割り込まれた）。結果は捨てる。
    if (prefetch) {
      prefetch.speech.catch(() => undefined);
      prefetch = undefined;
    }
    return synthesize(sentence);
  }

  function startPrefetch(): void {
    const next = queue.peek();
    if (!next) return;
    const speech = synthesize(next);
    speech.catch(() => undefined);
    prefetch = { sentence: next, speech };
  }

  function targetsFor(origin: SpeechOrigin): SpeechTargets {
    return selectSpeechTargets(origin, deps.outputs.current());
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    const endSpeaking = deps.presence.beginSpeaking();
    try {
      for (let sentence = queue.take(); sentence; sentence = queue.take()) {
        // **出口は取り出すたびに選び直す**（→ D-40）。積んでいる間に VC から
        // 抜けることも、ブラウザが「音を出す」を押すこともある。
        const targets = targetsFor(sentence.origin);
        if (hasNoTarget(targets)) {
          // 積んだ時点では出口があった文がここへ来る。遅れて届く読み上げに
          // 価値はないので捨てるが、**黙って捨てない**（INV-7）。
          deps.log.warn(
            { priority: sentence.priority, origin: sentence.origin.kind },
            'No output is listening any more — dropped the sentence',
          );
          continue;
        }

        try {
          const speech = await takeSpeech(sentence);
          startPrefetch();
          // **音を出す直前に出す**（→ D-38 の 4）。`play()` の内側に
          // 「鳴り始めた瞬間」を取れる場所は無い。
          //
          // ブラウザへ渡すのは **Discord へ流すのと同じバイト列**（→ D-39 の 1）。
          // 合成をもう 1 回するなら、それは経路が 2 本になったということ。
          // **口形は出口の選択と関係なく出す。** 消音のタブでも口は動く
          // （F-23）のが仕様で、`targets.browser` が見ているのは
          // 「音の出口として数えてよいか」だけ（→ D-40）。
          deps.avatar.publish({
            kind: 'speech',
            lipSync: speech.lipSync,
            speechId: deps.audio.put(speech.pcm),
          });
          if (targets.voice) {
            await deps.voice.play(speech.pcm);
          } else {
            // ブラウザだけが聞いている。**待つものが無いので自分で待つ** ——
            // 待たないと全文が一瞬で流れ、ブラウザ側は最後の 1 文だけが鳴る。
            await deps.sleep(Math.ceil(speech.lipSync.duration * 1000));
          }
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
      // **読み終わったら素の顔へ戻す**（→ D-41 の 3）。戻さないと最後の
      // 発話の顔が待機中ずっと残る。
      deps.expression?.relax();
      endSpeaking();
    }
  }

  return {
    speak(input) {
      // URL を外すのはここだけ。入口が 1 本（INV-5）なので、会話の応答・
      // 通知・リマインダーのどれから来ても素通りできない。テキスト配信は
      // この経路を通らないので、チャンネルには URL が残る。
      const sentences = splitIntoSentences(stripUrlsForSpeech(input.text));
      if (sentences.length === 0) return;

      // 出口がひとつも無いなら積まない。**これは縮退ではなく宛先の判定**
      // （DM の応答を VC で読まないのと同じ話）なので WARN にはしない。
      // 届かなかったことを表に出す責任は、呼び出し側（通知・リマインダー）が
      // `canSpeak()` で判定して負う。
      if (hasNoTarget(targetsFor(input.origin))) {
        deps.log.debug(
          { priority: input.priority, origin: input.origin.kind },
          'No output is listening — skipped the utterance',
        );
        return;
      }

      if (
        !queue.enqueue({
          priority: input.priority,
          sentences,
          origin: input.origin,
        })
      ) {
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

      // **表情は発話 1 つにつき 1 回**（→ D-41 の 1）。文ごとに判断すると
      // 短い文で顔がぱたぱた変わるうえ、外のモデルを文の数だけ呼ぶ。
      // 読み上げる文面（URL を外したもの）をそのまま渡す —— 声にしない
      // ものを判断の材料にしても噛み合わない。
      deps.expression?.forUtterance(sentences.join(''));

      deps.log.debug(
        { priority: input.priority, sentences: sentences.length },
        'Queued an utterance',
      );
      drain().catch((error) => {
        deps.log.error({ err: error }, 'Speech drain loop crashed');
      });
    },

    canSpeak: (origin) => !hasNoTarget(targetsFor(origin)),

    pending: () => queue.size(),
  };
}
