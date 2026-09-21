import { describe, expect, it, vi } from 'vitest';
import type { AvatarEvent } from '../../domain/avatar-event.ts';
import { createAvatarEventBroadcaster } from './avatar-event-broadcaster.ts';

const SPEECH: AvatarEvent = {
  kind: 'speech',
  lipSync: { frames: [{ at: 0, viseme: 'aa' }], duration: 0.3 },
  speechId: 'audio-1',
};

function setup() {
  const log = { error: vi.fn() };
  return { broadcaster: createAvatarEventBroadcaster({ log }), log };
}

describe('createAvatarEventBroadcaster', () => {
  it('購読している全員へ配る', () => {
    const { broadcaster } = setup();
    const a: AvatarEvent[] = [];
    const b: AvatarEvent[] = [];
    broadcaster.subscribe((event) => a.push(event), { audio: false });
    broadcaster.subscribe((event) => b.push(event), { audio: false });

    broadcaster.publish(SPEECH);

    expect(a.at(-1)).toEqual(SPEECH);
    expect(b.at(-1)).toEqual(SPEECH);
    expect(broadcaster.subscribers()).toBe(2);
  });

  // D-40。既定は消音なので、名乗ったタブだけを音の出口として数える。
  it('音を鳴らせると名乗ったタブだけを数える', () => {
    const { broadcaster } = setup();

    broadcaster.subscribe(() => undefined, { audio: false });
    expect(broadcaster.listeningBrowsers()).toBe(0);

    const stop = broadcaster.subscribe(() => undefined, { audio: true });
    expect(broadcaster.listeningBrowsers()).toBe(1);
    expect(broadcaster.subscribers()).toBe(2);

    stop();
    expect(broadcaster.listeningBrowsers()).toBe(0);
    expect(broadcaster.subscribers()).toBe(1);
  });

  // 読み上げの途中でページを開いた人が、次の発話まで待機の顔で止まらないように。
  it('購読した直後に今の状態を流す', () => {
    const { broadcaster } = setup();
    broadcaster.publish({ kind: 'state', state: 'speaking' });

    const received: AvatarEvent[] = [];
    broadcaster.subscribe((event) => received.push(event), { audio: false });

    expect(received).toEqual([{ kind: 'state', state: 'speaking' }]);
  });

  it('まだ何も起きていなければ待機を流す', () => {
    const { broadcaster } = setup();
    const received: AvatarEvent[] = [];
    broadcaster.subscribe((event) => received.push(event), { audio: false });

    expect(received).toEqual([{ kind: 'state', state: 'idle' }]);
  });

  // 過ぎた発話の口を後から動かしても意味がない。
  it('口形は溜めない（後から購読しても流れてこない）', () => {
    const { broadcaster } = setup();
    broadcaster.publish(SPEECH);

    const received: AvatarEvent[] = [];
    broadcaster.subscribe((event) => received.push(event), { audio: false });

    expect(received).toEqual([{ kind: 'state', state: 'idle' }]);
  });

  it('購読をやめたら届かなくなる', () => {
    const { broadcaster } = setup();
    const received: AvatarEvent[] = [];
    const unsubscribe = broadcaster.subscribe((event) => received.push(event), {
      audio: false,
    });
    unsubscribe();

    broadcaster.publish(SPEECH);

    expect(received).toHaveLength(1);
    expect(broadcaster.subscribers()).toBe(0);
  });

  // 1 人が投げても読み上げと他の購読者を巻き込まない（INV-7）。
  it('購読者が投げても他へは届き、ERROR に残る', () => {
    const { broadcaster, log } = setup();
    broadcaster.subscribe(
      () => {
        throw new Error('壊れた購読者');
      },
      { audio: false },
    );
    const received: AvatarEvent[] = [];
    broadcaster.subscribe((event) => received.push(event), { audio: false });

    expect(() => broadcaster.publish(SPEECH)).not.toThrow();
    expect(received.at(-1)).toEqual(SPEECH);
    expect(log.error).toHaveBeenCalled();
  });
});
