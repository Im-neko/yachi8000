/** 受け取った音声。**形式は入口が名乗ったものをそのまま運ぶ**（→ D-47 の 2）。 */
export interface RecordedUtterance {
  /**
   * **共有バッファではない** ことを型で言う。`Blob` と `fetch` が
   * `ArrayBuffer` 裏付けのものしか受けないため。
   */
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** `audio/webm` / `audio/mp4` / `audio/wav` のいずれか。 */
  readonly contentType: string;
}

/**
 * 文字起こし（F-13）。実体は LLM プロキシ経由の Whisper（→ D-16）。
 *
 * **空文字は「失敗」ではなく「聞き取れなかった」。** エンジンは 2 秒に
 * 満たない発話に対して、エラーではなく `{"text": ""}` を返す（実測 →
 * D-16 の追記の 3）。呼び出し側はこれを**普通に起こること**として扱う。
 */
export interface Transcriber {
  transcribe(utterance: RecordedUtterance): Promise<string>;
}
