import { describe, expect, it, vi } from 'vitest';
import type { VoiceChannelRef } from '../domain/ports/voice-output.ts';
import { createSpeechService, type SpeechDependencies } from './speech.ts';

const CHANNEL: VoiceChannelRef = { guildId: 'g', channelId: 'c' };

function createHarness() {
  const played: string[] = [];
  const synthesized: string[] = [];
  let connected: VoiceChannelRef | undefined = CHANNEL;
  let pending: { resolve: () => void } | undefined;
  let onPlay: (() => void) | undefined;

  const log = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const deps: SpeechDependencies = {
    synthesizer: {
      synthesize: async (text) => {
        synthesized.push(text);
        return { pcm: new TextEncoder().encode(text) };
      },
      verifyContract: async () => undefined,
    },
    voice: {
      join: async () => undefined,
      leave: () => false,
      current: () => connected,
      play: (pcm) =>
        new Promise<void>((resolve) => {
          played.push(new TextDecoder().decode(pcm));
          pending = { resolve };
          onPlay?.();
        }),
    },
    log,
  };

  return {
    service: createSpeechService(deps),
    played,
    synthesized,
    log,
    disconnect() {
      connected = undefined;
    },
    /** 次の再生が始まるまで待つ。 */
    waitForPlay(): Promise<void> {
      if (pending) return Promise.resolve();
      return new Promise<void>((resolve) => {
        onPlay = () => {
          onPlay = undefined;
          resolve();
        };
      });
    },
    /** 再生中の 1 文を終わらせる。 */
    finishPlay(): void {
      const current = pending;
      pending = undefined;
      current?.resolve();
    },
  };
}

describe('createSpeechService', () => {
  it('再生中に届いた通知を、次の文の切れ目で割り込ませる', async () => {
    const h = createHarness();

    h.service.speak({ text: 'R1。R2。R3。', priority: 'reply' });
    await h.waitForPlay();
    expect(h.played).toEqual(['R1。']);

    // R2 を先読み合成している最中に通知が届く。
    h.service.speak({ text: 'N。', priority: 'notification' });
    h.finishPlay();

    await h.waitForPlay();
    expect(h.played).toEqual(['R1。', 'N。']);

    h.finishPlay();
    await h.waitForPlay();
    h.finishPlay();
    await h.waitForPlay();
    h.finishPlay();

    expect(h.played).toEqual(['R1。', 'N。', 'R2。', 'R3。']);
  });

  it('割り込まれずに続く場合は先読みした合成結果を使い回す', async () => {
    const h = createHarness();

    h.service.speak({ text: 'A。B。', priority: 'reply' });
    await h.waitForPlay();
    h.finishPlay();
    await h.waitForPlay();
    h.finishPlay();

    expect(h.played).toEqual(['A。', 'B。']);
    expect(h.synthesized).toEqual(['A。', 'B。']);
  });

  it('再生中に VC から切れたら残りを捨てて WARN を出す', async () => {
    const h = createHarness();

    h.service.speak({ text: 'A。B。C。', priority: 'reply' });
    await h.waitForPlay();
    h.disconnect();
    h.finishPlay();
    await vi.waitFor(() => expect(h.log.warn).toHaveBeenCalled());

    expect(h.played).toEqual(['A。']);
    expect(h.log.warn.mock.calls[0]?.[0]).toEqual({ dropped: 2 });
  });

  it('上限を超えた発話は丸ごと捨てて WARN を出す', () => {
    const h = createHarness();

    // 上限（200 文）ちょうどまで積んだうえで、2 文の発話を投げる。
    // 1 文だけなら再生中の分の空きに入ってしまうので、入り切らない長さにする。
    const full = Array.from({ length: 200 }, (_, i) => `S${i}。`).join('');
    h.service.speak({ text: full, priority: 'reply' });
    h.service.speak({ text: 'あふれた。捨てられる。', priority: 'reply' });

    expect(h.log.warn).toHaveBeenCalledOnce();
    expect(h.played).not.toContain('あふれた。');
    expect(h.service.pending()).toBe(199);
  });
});
