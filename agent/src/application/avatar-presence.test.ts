import { describe, expect, it } from 'vitest';
import type { AvatarEvent } from '../domain/avatar-event.ts';
import { createAvatarPresence } from './avatar-presence.ts';

function setup() {
  const events: AvatarEvent[] = [];
  const presence = createAvatarPresence({
    publish: (event) => {
      events.push(event);
    },
  });
  const states = () =>
    events.map((event) => (event.kind === 'state' ? event.state : event.kind));
  return { presence, states };
}

describe('createAvatarPresence', () => {
  it('始まりと終わりで状態を出す', () => {
    const { presence, states } = setup();

    const end = presence.beginSpeaking();
    expect(presence.current()).toBe('speaking');
    end();

    expect(states()).toEqual(['speaking', 'idle']);
    expect(presence.current()).toBe('idle');
  });

  it('重なっているときは強いほうを出す（話している > 考えている）', () => {
    const { presence, states } = setup();

    const thinking = presence.beginThinking();
    const speaking = presence.beginSpeaking();
    expect(presence.current()).toBe('speaking');

    // 読み上げが終わっても、まだ考えている
    speaking();
    expect(presence.current()).toBe('thinking');

    thinking();
    expect(states()).toEqual(['thinking', 'speaking', 'thinking', 'idle']);
  });

  // 片方が終わったときにもう片方を消さない、がこの型の存在理由。
  it('同じ状態が重なっても、全部終わるまで待機に戻らない', () => {
    const { presence, states } = setup();

    const first = presence.beginThinking();
    const second = presence.beginThinking();

    first();
    expect(presence.current()).toBe('thinking');

    second();
    expect(presence.current()).toBe('idle');
    expect(states()).toEqual(['thinking', 'idle']);
  });

  it('終了を二度呼んでも数が狂わない', () => {
    const { presence, states } = setup();

    const first = presence.beginThinking();
    const second = presence.beginThinking();
    first();
    first();

    expect(presence.current()).toBe('thinking');
    second();
    expect(states()).toEqual(['thinking', 'idle']);
  });

  it('変わらなければ出さない', () => {
    const { presence, states } = setup();

    const first = presence.beginSpeaking();
    const second = presence.beginSpeaking();
    first();
    second();

    expect(states()).toEqual(['speaking', 'idle']);
  });
});
