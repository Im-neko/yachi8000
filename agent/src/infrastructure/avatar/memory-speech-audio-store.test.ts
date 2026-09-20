import { describe, expect, it } from 'vitest';
import { createMemorySpeechAudioStore } from './memory-speech-audio-store.ts';

const pcm = (size: number) => new Uint8Array(size).fill(1);

describe('createMemorySpeechAudioStore', () => {
  it('預けた音を ID で引ける', () => {
    const store = createMemorySpeechAudioStore();
    const id = store.put(pcm(100));

    expect(store.get(id)).toEqual(pcm(100));
  });

  // 会話の中身そのものを返すエンドポイントなので、ID は数えられない値にする。
  it('ID は推測できない値で、預けるたびに変わる', () => {
    const store = createMemorySpeechAudioStore();
    const first = store.put(pcm(10));
    const second = store.put(pcm(10));

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('知らない ID は undefined', () => {
    const store = createMemorySpeechAudioStore();
    expect(store.get('だれのものでもない')).toBeUndefined();
  });

  it('大きさの上限を超えたら古いものから捨てる', () => {
    const store = createMemorySpeechAudioStore({ maxBytes: 250 });
    const first = store.put(pcm(100));
    const second = store.put(pcm(100));
    const third = store.put(pcm(100));

    expect(store.get(first)).toBeUndefined();
    expect(store.get(second)).toEqual(pcm(100));
    expect(store.get(third)).toEqual(pcm(100));
  });

  it('寿命を過ぎたものは、上限に余裕があっても消える', () => {
    let now = 0;
    const store = createMemorySpeechAudioStore({
      maxAgeSeconds: 10,
      now: () => now,
    });
    const old = store.put(pcm(10));

    now = 11_000;
    const fresh = store.put(pcm(10));

    expect(store.get(old)).toBeUndefined();
    expect(store.get(fresh)).toEqual(pcm(10));
  });

  // 取りに来ないまま時間が経つ経路もある（ブラウザを開いていないとき）。
  it('預ける側が止まっても、取りに来た時点で寿命は効く', () => {
    let now = 0;
    const store = createMemorySpeechAudioStore({
      maxAgeSeconds: 10,
      now: () => now,
    });
    const id = store.put(pcm(10));

    now = 11_000;
    expect(store.get(id)).toBeUndefined();
  });

  // 再接続や再読み込みで同じ音を取り直すことがある。
  it('同じ音を二度取れる', () => {
    const store = createMemorySpeechAudioStore();
    const id = store.put(pcm(10));

    expect(store.get(id)).toEqual(pcm(10));
    expect(store.get(id)).toEqual(pcm(10));
  });
});
