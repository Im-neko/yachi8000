/**
 * ブラウザへ渡す発話の音（F-23）。
 *
 * **Discord へ流したのと同じバイト列を包み直すだけ。** 合成をもう 1 回する
 * のではない —— 2 回合成したら発話の経路が 2 本になる（→ INV-5, D-39 の 1）。
 */

/** 合成エンジンに出させている形。VOICEVOX 側の指定と揃っている。 */
export const SPEECH_SAMPLE_RATE = 48000;
export const SPEECH_CHANNELS = 2;
export const SPEECH_BITS_PER_SAMPLE = 16;

/** WAV のヘッダは 44 バイト固定（PCM・拡張なし）。 */
const HEADER_BYTES = 44;

/** 1 秒あたりのバイト数。 */
const BYTES_PER_SECOND =
  SPEECH_SAMPLE_RATE * SPEECH_CHANNELS * (SPEECH_BITS_PER_SAMPLE / 8);

/**
 * PCM に WAV のヘッダを付ける。
 *
 * **ブラウザは裸の PCM を再生できない。** Discord 側は逆にヘッダが邪魔
 * （`@discordjs/voice` へは PCM のまま渡す）なので、付けるのはこちらだけ。
 */
export function wavFromPcm(pcm: Uint8Array): Uint8Array {
  const wav = new Uint8Array(HEADER_BYTES + pcm.byteLength);
  const view = new DataView(wav.buffer);

  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt チャンクの長さ
  view.setUint16(20, 1, true); // 1 = リニア PCM
  view.setUint16(22, SPEECH_CHANNELS, true);
  view.setUint32(24, SPEECH_SAMPLE_RATE, true);
  view.setUint32(28, BYTES_PER_SECOND, true);
  view.setUint16(32, SPEECH_CHANNELS * (SPEECH_BITS_PER_SAMPLE / 8), true);
  view.setUint16(34, SPEECH_BITS_PER_SAMPLE, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, HEADER_BYTES);

  return wav;
}
