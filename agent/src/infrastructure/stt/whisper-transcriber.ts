import {
  type RecordedUtterance,
  type Transcriber,
  TranscriptionFailure,
} from '../../domain/ports/transcriber.ts';
import { logger } from '../../observability/logger.ts';

/**
 * 文字起こしの時間切れ（→ Q-29）。
 *
 * 実測では 534〜612 ms で返る（→ D-16 の追記）。**それでも長めに取る** ——
 * エンジンは落ちることがあり、落ちている間は無応答になる（HTTP エラーが
 * 返らない）。短くしすぎると、単に遅いだけの回まで落とすことになる。
 */
const TIMEOUT_MS = 10_000;

export interface CreateWhisperTranscriberInput {
  /** LLM プロキシの OpenAI 互換エンドポイント。`/v1` まで含む。 */
  baseUrl: string;
  apiKey: string;
  /** `model_list[].model_name`。`mode: audio_transcription` のもの。 */
  model: string;
}

/**
 * LLM プロキシ経由の Whisper（→ D-16）。
 *
 * **受け取った音声をそのまま渡す。** `audio/wav` / `audio/webm` / `audio/mp4`
 * の 3 形式が通ることは実測済みで、**サーバ側で変換する理由が無い**
 * （→ D-47 の 2）。Android は webm、iOS は mp4 を出す。
 */
export function createWhisperTranscriber(
  input: CreateWhisperTranscriberInput,
): Transcriber {
  const baseUrl = input.baseUrl.replace(/\/$/, '');

  return {
    async transcribe(utterance: RecordedUtterance): Promise<string> {
      const form = new FormData();
      form.set('model', input.model);
      form.set(
        'file',
        new Blob([utterance.bytes], {
          type: utterance.contentType,
        }),
        // 拡張子は付けない。**形式は content-type で名乗る** —— 名前から
        // 推測させると、webm と mp4 を取り違えたときに黙って失敗する。
        'utterance',
      );

      const started = Date.now();
      const response = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${input.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 429) {
        // **枠切れ。** さくらのフリープランは音声認識が 1 ヶ月 50 リクエスト
        // で、超えると翌月まで戻らない（→ Q-29）。待っても直らないので、
        // 「落ちている」と同じ言い方をしない。
        throw new TranscriptionFailure(
          '文字起こしの利用枠を使い切っています。',
          'rate-limited',
        );
      }
      if (!response.ok) {
        throw new TranscriptionFailure(
          `文字起こしが失敗しました: ${response.status} ${response.statusText}`,
          'unavailable',
        );
      }

      const body = (await response.json()) as { text?: unknown };
      if (typeof body.text !== 'string') {
        throw new TranscriptionFailure(
          '文字起こしの応答に text がありません。audio_transcription のモデルを指しているか確認してください（D-16）。',
          'unavailable',
        );
      }

      logger.debug(
        {
          elapsedMs: Date.now() - started,
          bytes: utterance.bytes.length,
          contentType: utterance.contentType,
          heard: body.text !== '',
        },
        'Transcribed an utterance',
      );
      return body.text.trim();
    },
  };
}
