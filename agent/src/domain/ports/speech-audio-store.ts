/**
 * ブラウザが取りに来るまで、合成した音を短い間だけ持っておく口（F-23）。
 *
 * **持つのは直近だけ**（→ D-39 の 5）。発話の音は作り直せるし、残す価値も
 * 無い。永続ボリュームには置かない。
 */
export interface SpeechAudioStore {
  /**
   * 音を預けて ID を返す。**ID は推測できない値にすること** ——
   * このエンドポイントは会話の中身そのものを返す（→ D-39 の 6）。
   */
  put(pcm: Uint8Array): string;
  /** 消えていたら undefined。取りに来るのが遅れれば普通に起こる。 */
  get(id: string): Uint8Array | undefined;
}
