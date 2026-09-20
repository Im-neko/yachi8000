import { describe, expect, it, vi } from 'vitest';
import type { AvatarEvent } from '../domain/avatar-event.ts';
import type { VisemeTimeline } from '../domain/lipsync.ts';
import type { VoiceChannelRef } from '../domain/ports/voice-output.ts';
import { createAvatarPresence } from './avatar-presence.ts';
import { createSpeechService, type SpeechDependencies } from './speech.ts';

const CHANNEL: VoiceChannelRef = { guildId: 'g', channelId: 'c' };

/** 文ごとに見分けが付く口形列。合成した文と結び付いていることを確かめる用。 */
function timelineFor(text: string): VisemeTimeline {
  return {
    frames: [{ at: 0, viseme: text.startsWith('N') ? 'ih' : 'aa' }],
    duration: text.length / 10,
  };
}

function createHarness() {
  const played: string[] = [];
  const synthesized: string[] = [];
  const events: AvatarEvent[] = [];
  let connected: VoiceChannelRef | undefined = CHANNEL;
  let pending: { resolve: () => void } | undefined;
  let onPlay: (() => void) | undefined;
  let failNext = false;

  const log = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const deps: SpeechDependencies = {
    synthesizer: {
      synthesize: async (text) => {
        synthesized.push(text);
        if (failNext) {
          failNext = false;
          throw new Error('合成に失敗しました');
        }
        return {
          pcm: new TextEncoder().encode(text),
          lipSync: timelineFor(text),
        };
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
    avatar: {
      publish: (event) => {
        events.push(event);
      },
    },
    presence: createAvatarPresence({
      publish: (event) => {
        events.push(event);
      },
    }),
    log,
  };

  return {
    service: createSpeechService(deps),
    played,
    synthesized,
    events,
    log,
    disconnect() {
      connected = undefined;
    },
    /** 次の合成を 1 回だけ失敗させる。 */
    failNext() {
      failNext = true;
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

  // F-21。口形はこの経路からしか出ない（入口ごとに書かない → INV-5）。
  it('文を再生する直前に、その文の口形を出す', async () => {
    const h = createHarness();

    h.service.speak({ text: 'A。', priority: 'reply' });
    await h.waitForPlay();

    expect(h.events).toEqual([
      { kind: 'state', state: 'speaking' },
      { kind: 'speech', lipSync: timelineFor('A。') },
    ]);

    h.finishPlay();
    await vi.waitFor(() =>
      expect(h.events.at(-1)).toEqual({ kind: 'state', state: 'idle' }),
    );
  });

  it('割り込まれたら、実際に再生する文の口形を出す', async () => {
    const h = createHarness();

    h.service.speak({ text: 'R1。R2。', priority: 'reply' });
    await h.waitForPlay();
    h.service.speak({ text: 'N。', priority: 'notification' });
    h.finishPlay();
    await h.waitForPlay();

    const spoken = h.events.filter((event) => event.kind === 'speech');
    expect(spoken).toEqual([
      { kind: 'speech', lipSync: timelineFor('R1。') },
      { kind: 'speech', lipSync: timelineFor('N。') },
    ]);
  });

  // 合成に失敗した文で口だけ動く、を防ぐ。
  it('合成に失敗した文の口形は出さない', async () => {
    const h = createHarness();
    h.failNext();

    h.service.speak({ text: 'A。B。', priority: 'reply' });
    await h.waitForPlay();

    expect(h.played).toEqual(['B。']);
    expect(h.events.filter((event) => event.kind === 'speech')).toEqual([
      { kind: 'speech', lipSync: timelineFor('B。') },
    ]);
  });

  it('URL は合成に渡さない（テキスト配信側には残る）', async () => {
    const { service, synthesized } = createHarness();

    service.speak({
      text: 'PR を出しました。https://example.com/pr/1 を見てください。',
      priority: 'notification',
    });
    await vi.waitFor(() => {
      expect(synthesized.length).toBe(2);
    });

    expect(synthesized).toEqual([
      'PR を出しました。',
      'リンク を見てください。',
    ]);
  });
});
