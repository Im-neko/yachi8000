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

/**
 * 文字起こしが**できなかった**理由（→ Q-29）。
 *
 * **「枠切れ」と「落ちている」を分ける。** どちらも聞き取れない点は同じだが、
 * 利用者に言うべきことが違う —— 前者は数秒待っても直らず（枠を増やすか
 * 別の口を用意するまで続く）、後者は数分で戻ることがある。同じ「いま聞き取れません」にまとめると、
 * 2026-09-22 にこちらがやったのと同じ読み違えを利用者にもさせる。
 */
export type TranscriptionFailureReason = 'rate-limited' | 'unavailable';

export class TranscriptionFailure extends Error {
  constructor(
    message: string,
    readonly reason: TranscriptionFailureReason,
  ) {
    super(message);
    this.name = 'TranscriptionFailure';
  }
}
