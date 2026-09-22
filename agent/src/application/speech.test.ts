import { describe, expect, it, vi } from 'vitest';
import type { AvatarEvent } from '../domain/avatar-event.ts';
import type { VisemeTimeline } from '../domain/lipsync.ts';
import type { VoiceChannelRef } from '../domain/ports/voice-output.ts';
import { createAvatarPresence } from './avatar-presence.ts';
import { createSpeechService, type SpeechDependencies } from './speech.ts';

const CHANNEL: VoiceChannelRef = { guildId: 'g', channelId: 'c' };

/** 既定の出どころ。VC と同じサーバの会話（＝ VC もブラウザも受け取る）。 */
const ORIGIN = { kind: 'conversation', guildId: 'g' } as const;

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
  const stored = new Map<string, string>();
  let connected: VoiceChannelRef | undefined = CHANNEL;
  let listeningBrowsers = 0;
  const slept: number[] = [];
  let pending: { resolve: () => void } | undefined;
  let onPlay: (() => void) | undefined;
  let failNext = false;

  const log = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  /** 表情へ渡った文面と、素の顔へ戻した回数（F-24）。 */
  const utterances: string[] = [];
  let relaxed = 0;

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
      listSpeakers: async () => [],
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
    outputs: {
      current: () => ({
        voiceGuildId: connected?.guildId,
        listeningBrowsers,
      }),
    },
    sleep: async (ms) => {
      slept.push(ms);
    },
    avatar: {
      publish: (event) => {
        events.push(event);
      },
    },
    expression: {
      forUtterance: (text) => utterances.push(text),
      relax: () => {
        relaxed++;
      },
    },
    audio: {
      // 預けた音を ID から引けるようにして、口形と同じ文の音かを確かめる。
      put: (pcm) => {
        const id = `audio-${stored.size}`;
        stored.set(id, new TextDecoder().decode(pcm));
        return id;
      },
      get: () => undefined,
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
    stored,
    log,
    slept,
    utterances,
    relaxedCount: () => relaxed,
    disconnect() {
      connected = undefined;
    },
    /** ブラウザが「音を出す」を押した状態にする（F-23, D-40）。 */
    openBrowser() {
      listeningBrowsers = 1;
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

    h.service.speak({
      text: 'R1。R2。R3。',
      priority: 'reply',
      origin: ORIGIN,
    });
    await h.waitForPlay();
    expect(h.played).toEqual(['R1。']);

    // R2 を先読み合成している最中に通知が届く。
    h.service.speak({ text: 'N。', priority: 'notification', origin: ORIGIN });
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

    h.service.speak({ text: 'A。B。', priority: 'reply', origin: ORIGIN });
    await h.waitForPlay();
    h.finishPlay();
    await h.waitForPlay();
    h.finishPlay();

    expect(h.played).toEqual(['A。', 'B。']);
    expect(h.synthesized).toEqual(['A。', 'B。']);
  });

  // F-24 / D-41 の 1。文ごとに判断させると顔がぱたぱた変わる。
  it('表情は発話 1 つにつき 1 回、読み上げる文面で頼む', async () => {
    const h = createHarness();

    h.service.speak({
      text: 'A。B。 https://example.com/x',
      priority: 'reply',
      origin: ORIGIN,
    });

    // 声にしない URL は判断の材料にもしない（読み上げる文面をそのまま渡す）。
    expect(h.utterances).toEqual(['A。B。リンク']);
  });

  // D-41 の 3。戻さないと最後の発話の顔が待機中ずっと残る。
  it('読み終わったら素の顔へ戻す', async () => {
    const h = createHarness();

    h.service.speak({ text: 'A。', priority: 'reply', origin: ORIGIN });
    await h.waitForPlay();
    expect(h.relaxedCount()).toBe(0);

    h.finishPlay();
    await vi.waitFor(() => expect(h.relaxedCount()).toBe(1));
  });

  it('再生中に出口が全部いなくなったら、残りを捨てて WARN を出す', async () => {
    const h = createHarness();

    h.service.speak({ text: 'A。B。C。', priority: 'reply', origin: ORIGIN });
    await h.waitForPlay();
    h.disconnect();
    h.finishPlay();
    await vi.waitFor(() => expect(h.log.warn).toHaveBeenCalledTimes(2));

    expect(h.played).toEqual(['A。']);
    // **B は先読みで合成済み**（A の再生中に仕込む → D-11）。出口が無くなった
    // のはその後なので、合成 1 回ぶんは無駄になる。**これは意図した無駄**で、
    // 先読みをやめると文の間に無音が空く。
    expect(h.synthesized).toEqual(['A。', 'B。']);
    // 残った 2 文は 1 文ずつ捨てる。**どれを捨てたかが分かる形にする**
    // （出どころごとに出口が違うので、まとめて捨てると理由が消える → D-40）。
    expect(h.log.warn.mock.calls[0]?.[0]).toEqual({
      priority: 'reply',
      origin: 'conversation',
    });
  });

  // D-40。Discord と Web は対等なので、VC にいなくても喋る。
  it('VC にいなくても、音を鳴らせるブラウザが開いていれば喋る', async () => {
    const h = createHarness();
    h.disconnect();
    h.openBrowser();

    h.service.speak({ text: 'A。B。', priority: 'reply', origin: ORIGIN });
    await vi.waitFor(() => expect(h.synthesized).toEqual(['A。', 'B。']));

    // VC へは流れない。**再生の歩調は口形の長さで取る** —— 待たないと
    // 全文が一瞬で流れ、ブラウザ側は最後の 1 文だけが鳴る。
    expect(h.played).toEqual([]);
    expect(h.slept).toEqual([200, 200]);
    expect(h.events.filter((event) => event.kind === 'speech')).toHaveLength(2);
  });

  it('VC にもブラウザにも出口が無ければ、積まずに捨てる', async () => {
    const h = createHarness();
    h.disconnect();

    h.service.speak({ text: 'A。B。', priority: 'reply', origin: ORIGIN });

    expect(h.service.pending()).toBe(0);
    expect(h.synthesized).toEqual([]);
    // 宛先の判定であって縮退ではないので WARN にはしない（→ D-40）。
    expect(h.log.warn).not.toHaveBeenCalled();
    expect(h.log.debug).toHaveBeenCalled();
  });

  it('DM の応答はブラウザへ出さない（Q-26 が決まるまで）', () => {
    const h = createHarness();
    h.disconnect();
    h.openBrowser();

    h.service.speak({
      text: 'DM です。',
      priority: 'reply',
      origin: { kind: 'conversation' },
    });

    expect(h.service.pending()).toBe(0);
    expect(h.synthesized).toEqual([]);
  });

  it('上限を超えた発話は丸ごと捨てて WARN を出す', () => {
    const h = createHarness();

    // 上限（200 文）ちょうどまで積んだうえで、2 文の発話を投げる。
    // 1 文だけなら再生中の分の空きに入ってしまうので、入り切らない長さにする。
    const full = Array.from({ length: 200 }, (_, i) => `S${i}。`).join('');
    h.service.speak({ text: full, priority: 'reply', origin: ORIGIN });
    h.service.speak({
      text: 'あふれた。捨てられる。',
      priority: 'reply',
      origin: ORIGIN,
    });

    expect(h.log.warn).toHaveBeenCalledOnce();
    expect(h.played).not.toContain('あふれた。');
    expect(h.service.pending()).toBe(199);
  });

  // F-21。口形はこの経路からしか出ない（入口ごとに書かない → INV-5）。
  it('文を再生する直前に、その文の口形を出す', async () => {
    const h = createHarness();

    h.service.speak({ text: 'A。', priority: 'reply', origin: ORIGIN });
    await h.waitForPlay();

    expect(h.events).toEqual([
      { kind: 'state', state: 'speaking' },
      { kind: 'speech', lipSync: timelineFor('A。'), speechId: 'audio-0' },
    ]);

    h.finishPlay();
    await vi.waitFor(() =>
      expect(h.events.at(-1)).toEqual({ kind: 'state', state: 'idle' }),
    );
  });

  it('割り込まれたら、実際に再生する文の口形を出す', async () => {
    const h = createHarness();

    h.service.speak({ text: 'R1。R2。', priority: 'reply', origin: ORIGIN });
    await h.waitForPlay();
    h.service.speak({ text: 'N。', priority: 'notification', origin: ORIGIN });
    h.finishPlay();
    await h.waitForPlay();

    const spoken = h.events.filter((event) => event.kind === 'speech');
    expect(spoken.map((event) => event.lipSync)).toEqual([
      timelineFor('R1。'),
      timelineFor('N。'),
    ]);
  });

  // 合成に失敗した文で口だけ動く、を防ぐ。
  it('合成に失敗した文の口形は出さない', async () => {
    const h = createHarness();
    h.failNext();

    h.service.speak({ text: 'A。B。', priority: 'reply', origin: ORIGIN });
    await h.waitForPlay();

    expect(h.played).toEqual(['B。']);
    expect(h.events.filter((event) => event.kind === 'speech')).toEqual([
      { kind: 'speech', lipSync: timelineFor('B。'), speechId: 'audio-0' },
    ]);
  });

  // F-23。**Discord へ流すのと同じバイト列**でなければ、口と音がずれる
  // どころか別の文が鳴る（→ D-39 の 1）。
  it('ブラウザへ渡す音は、Discord へ流したのと同じ合成結果', async () => {
    const h = createHarness();

    h.service.speak({ text: 'A。B。', priority: 'reply', origin: ORIGIN });
    await h.waitForPlay();
    h.finishPlay();
    await h.waitForPlay();

    const spoken = h.events.filter((event) => event.kind === 'speech');
    expect(spoken.map((event) => h.stored.get(event.speechId))).toEqual(
      h.played,
    );
  });

  it('URL は合成に渡さない（テキスト配信側には残る）', async () => {
    const { service, synthesized } = createHarness();

    service.speak({
      text: 'PR を出しました。https://example.com/pr/1 を見てください。',
      priority: 'notification',
      origin: ORIGIN,
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
