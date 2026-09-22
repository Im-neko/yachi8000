/**
 * ブラウザのマイクから 1 発話ぶんを録る（F-13 の経路 B、→ D-47）。
 *
 * **1 発話 = 1 ファイル = 1 回の POST。** WebSocket は使わない（agent 側に
 * 生やす場所が無い → D-38 の 1 と同じ理由）。
 */

/**
 * 録れる形式。**端末によって出せるものが違う** —— Android Chrome は webm、
 * iOS Safari は mp4。どちらも文字起こしがそのまま受けることは実測済み
 * （→ D-16 の追記の 2）ので、**変換しない。**
 */
const PREFERRED = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
] as const;

export interface Recording {
  readonly blob: Blob;
  /** サーバへ名乗る形式。`MediaRecorder` が実際に使ったもの。 */
  readonly contentType: string;
}

export interface Microphone {
  recording(): boolean;
  /** 録り始める。**利用者の操作の中で呼ぶ**（許可を求めるため）。 */
  start(): Promise<void>;
  /** 録り終える。**何も録れていなければ undefined。** */
  stop(): Promise<Recording | undefined>;
}

function pickType(): string | undefined {
  // **知っている形式だけを使う。** 端末任せにすると、agent 側が受けない
  // 形式（ogg など）で録れてしまい、送ってから 415 で弾かれる。
  return PREFERRED.find((type) => MediaRecorder.isTypeSupported(type));
}

export function createMicrophone(): Microphone {
  let recorder: MediaRecorder | undefined;
  let stream: MediaStream | undefined;
  let chunks: Blob[] = [];

  /** マイクを離す。**録り終えたら必ず呼ぶ** —— 端末の録音中の表示が残る。 */
  function release(): void {
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = undefined;
    recorder = undefined;
  }

  return {
    recording: () => recorder?.state === 'recording',

    async start(): Promise<void> {
      const type = pickType();
      if (!type) {
        throw new Error('このブラウザでは音声を録れません。');
      }
      // **毎回取り直す。** 開きっぱなしにすると、話していない間も端末の
      // 録音中の表示が出たままになる（何を録られているか分からなくなる）。
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      recorder = new MediaRecorder(stream, { mimeType: type });
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      recorder.start();
    },

    stop(): Promise<Recording | undefined> {
      const active = recorder;
      if (active?.state !== 'recording') {
        release();
        return Promise.resolve(undefined);
      }
      const contentType = active.mimeType;

      return new Promise<Recording | undefined>((resolve) => {
        active.addEventListener(
          'stop',
          () => {
            const blob = new Blob(chunks, { type: contentType });
            release();
            resolve(blob.size > 0 ? { blob, contentType } : undefined);
          },
          { once: true },
        );
        active.stop();
      });
    },
  };
}
