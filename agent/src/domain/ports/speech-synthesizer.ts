import type { VisemeTimeline } from '../lipsync.ts';

export interface SynthesizedSpeech {
  /** 48000Hz / 2ch / 16bit LE の PCM。WAV ヘッダは含まない。 */
  readonly pcm: Uint8Array;
  /**
   * 口形の切り替え時刻（F-21）。**音と同じ合成から作る** ——
   * 別の経路で取り直すと、話速を変えた瞬間に口だけずれる（→ D-38 の 2）。
   */
  readonly lipSync: VisemeTimeline;
}

/**
 * 音声合成エンジン（F-12）。実体は VOICEVOX 互換 API を持つ別 Deployment
 * で、yachi8000 は接続情報だけを受け取る（D-05）。
 */
export interface SpeechSynthesizer {
  synthesize(text: string): Promise<SynthesizedSpeech>;

  /**
   * 起動時に API の契約を検証する。満たさなければ throw して起動を止める。
   *
   * 合成だけ通ってリップシンク（F-21）が黙って壊れる、が最悪の壊れ方なので、
   * `/synthesis` が動くことではなく **`/audio_query` がモーラを返すこと**まで確かめる。
   */
  verifyContract(): Promise<void>;
}
