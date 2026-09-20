/**
 * 読み上げをブラウザでも鳴らす（F-23）。
 *
 * **既定では鳴らさない。** 理由が 2 つ重なっている（→ D-39 の 3）——
 * VC にも入っている人は二重に聞くことになるし、そもそも**ブラウザは操作
 * なしに音を出せない**（自動再生の制限）。
 */

export interface SpeechPlayback {
  /** 鳴り始めてからの秒数。まだ鳴っていなければ 0。 */
  elapsed(): number;
}

export interface SpeechAudio {
  /**
   * 利用者の操作の中で呼ぶ。ここで一度 `play()` を通しておくと、以後は
   * こちらの好きなときに鳴らせるようになる（同じ要素を使い回すため）。
   */
  enable(): Promise<void>;
  enabled(): boolean;
  /**
   * 鳴らす。**前の音は止めて差し替える** —— 発話は 1 本の経路から順に
   * 来るので（INV-5）、重なっているなら前のほうが古い。
   *
   * 鳴らせなかった場合（まだ押されていない・音が消えていた）は undefined。
   * **そのときは口だけ動かす**ので、呼び出し側は落ちない。
   */
  play(url: string): Promise<SpeechPlayback | undefined>;
}

/** 自動再生の制限を外すためだけの、ごく短い無音。 */
const SILENCE =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';

export function createSpeechAudio(): SpeechAudio {
  // **要素は 1 つを使い回す。** 鳴らすたびに new すると、そのたびに
  // 自動再生の制限に引っかかる（解除されるのは操作の中で鳴らした要素だけ）。
  const element = new Audio();
  element.preload = 'auto';
  let unlocked = false;

  return {
    async enable() {
      element.src = SILENCE;
      await element.play();
      unlocked = true;
    },

    enabled: () => unlocked,

    async play(url) {
      if (!unlocked) return undefined;
      element.src = url;
      try {
        await element.play();
      } catch {
        // 音が消えていた（→ D-39 の 5）か、再生を止められた。
        // **口は動かす**ので、ここで投げない。
        return undefined;
      }
      return { elapsed: () => element.currentTime };
    },
  };
}
