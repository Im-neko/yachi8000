import { randomUUID } from 'node:crypto';
import type { SpeechAudioStore } from '../../domain/ports/speech-audio-store.ts';

/**
 * 合成した音を直近ぶんだけメモリに置く（F-23、→ D-39 の 5）。
 *
 * **上限は大きさと時間の両方で持つ。** 大きさだけだと、短い発話が延々と
 * 残って「もう誰も取りに来ない音」がメモリを占める。時間だけだと、長い
 * 発話が続いたときに上限が効かない。
 *
 * **永続ボリュームには置かない。** 発話の音は作り直せるし、残す価値も無い
 * （音声バッファは `emptyDir`、という既存の方針と同じ）。
 */
export interface CreateMemorySpeechAudioStoreInput {
  /** 溜める上限（バイト）。 */
  maxBytes?: number;
  /** 溜める上限（秒）。ここを過ぎたものは取りに来ても無い。 */
  maxAgeSeconds?: number;
  /** テスト用。既定は実時間。 */
  now?: () => number;
}

/**
 * 48kHz / 2ch / 16bit で 1 秒あたり 192KB。既定は 30 秒ぶんほど。
 *
 * ブラウザが取りに来るのは**読み上げと同時**なので、本来は数秒あれば足りる。
 * 余裕を持たせているのは、回線が細いときに取り切れずに消えるのを避けるため。
 */
const DEFAULT_MAX_BYTES = 6 * 1024 * 1024;
const DEFAULT_MAX_AGE_SECONDS = 60;

interface Entry {
  id: string;
  pcm: Uint8Array;
  storedAt: number;
}

export function createMemorySpeechAudioStore(
  input: CreateMemorySpeechAudioStoreInput = {},
): SpeechAudioStore {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const now = input.now ?? Date.now;

  // 挿入順が保たれるので、古いものから捨てるのに Map をそのまま使える。
  const entries = new Map<string, Entry>();
  let bytes = 0;

  function drop(entry: Entry): void {
    entries.delete(entry.id);
    bytes -= entry.pcm.byteLength;
  }

  function evict(): void {
    const deadline = now() - maxAgeSeconds * 1000;
    for (const entry of entries.values()) {
      if (bytes <= maxBytes && entry.storedAt >= deadline) break;
      drop(entry);
    }
  }

  return {
    put(pcm) {
      const id = randomUUID();
      entries.set(id, { id, pcm, storedAt: now() });
      bytes += pcm.byteLength;
      evict();
      return id;
    },

    get(id) {
      evict();
      const entry = entries.get(id);
      if (!entry) return undefined;
      // 1 回鳴らしたら用済みだが、消さずに残す —— ブラウザは再接続や
      // 再読み込みで同じ音を取り直すことがあり、寿命で消えれば十分。
      return entry.pcm;
    },
  };
}
