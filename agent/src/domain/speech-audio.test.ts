import { describe, expect, it } from 'vitest';
import {
  SPEECH_BITS_PER_SAMPLE,
  SPEECH_CHANNELS,
  SPEECH_SAMPLE_RATE,
  wavFromPcm,
} from './speech-audio.ts';

const ascii = (wav: Uint8Array, offset: number) =>
  String.fromCharCode(...wav.subarray(offset, offset + 4));

describe('wavFromPcm', () => {
  it('ブラウザが再生できる形（RIFF/WAVE）にする', () => {
    const wav = wavFromPcm(new Uint8Array([1, 2, 3, 4]));

    expect(ascii(wav, 0)).toBe('RIFF');
    expect(ascii(wav, 8)).toBe('WAVE');
    expect(ascii(wav, 12)).toBe('fmt ');
    expect(ascii(wav, 36)).toBe('data');
  });

  // エンジンに出させている形と食い違うと、速さも高さも狂って再生される。
  it('合成エンジンに指定している形をそのまま書く', () => {
    const wav = wavFromPcm(new Uint8Array(8));
    const view = new DataView(wav.buffer);

    expect(view.getUint16(22, true)).toBe(SPEECH_CHANNELS);
    expect(view.getUint32(24, true)).toBe(SPEECH_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(SPEECH_BITS_PER_SAMPLE);
    // 1 秒あたりのバイト数と 1 サンプルぶんの大きさ
    expect(view.getUint32(28, true)).toBe(48000 * 2 * 2);
    expect(view.getUint16(32, true)).toBe(4);
  });

  it('長さの欄が中身と合っている', () => {
    const pcm = new Uint8Array(100);
    const wav = wavFromPcm(pcm);
    const view = new DataView(wav.buffer);

    expect(wav.byteLength).toBe(144);
    expect(view.getUint32(4, true)).toBe(136);
    expect(view.getUint32(40, true)).toBe(100);
  });

  it('PCM をそのまま後ろに置く（変換しない）', () => {
    const pcm = new Uint8Array([9, 8, 7, 6]);
    expect(wavFromPcm(pcm).subarray(44)).toEqual(pcm);
  });
});
