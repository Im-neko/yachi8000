import { describe, expect, it, vi } from 'vitest';
import type { Settings } from '../domain/settings.ts';
import {
  resolveWebSpeaker,
  transcribeUtterance,
  type VoiceInputDependencies,
} from './voice-input.ts';

function createDeps(
  options: {
    speakers?: Record<string, string>;
    transcribe?: () => Promise<string>;
  } = {},
): VoiceInputDependencies {
  return {
    settings: {
      get: () =>
        ({
          web: options.speakers ? { speakers: options.speakers } : undefined,
        }) as unknown as Settings,
    },
    transcriber: options.transcribe
      ? { transcribe: options.transcribe }
      : undefined,
    log: { info: vi.fn(), warn: vi.fn() },
  };
}

const utterance = {
  bytes: new Uint8Array([1, 2, 3]),
  contentType: 'audio/webm',
};

describe('resolveWebSpeaker', () => {
  it('対応表から話者を引く', () => {
    const deps = createDeps({ speakers: { yuki: 'discord-user-123456789' } });

    expect(resolveWebSpeaker(deps, 'yuki')).toEqual({
      speakerId: 'discord-user-123456789',
      userId: '123456789',
    });
  });

  it('対応表に無い人は話者にしない', () => {
    const deps = createDeps({ speakers: { yuki: 'discord-user-123456789' } });

    expect(resolveWebSpeaker(deps, 'someone-else')).toBeUndefined();
  });

  it('対応表そのものが無ければ話者にしない', () => {
    expect(resolveWebSpeaker(createDeps(), 'yuki')).toBeUndefined();
  });

  it('利用者名が届いていなければ話者にしない', () => {
    const deps = createDeps({ speakers: { yuki: 'discord-user-123456789' } });

    expect(resolveWebSpeaker(deps, undefined)).toBeUndefined();
  });

  it('形の壊れた値は通さず、ログに残す', () => {
    // スキーマが弾くはずの値。**黙って話者として通さない**
    // —— 帰属の間違った記憶は、あとから選り分けられない。
    const deps = createDeps({ speakers: { yuki: 'discord-user-' } });

    expect(resolveWebSpeaker(deps, 'yuki')).toBeUndefined();
    expect(deps.log.warn).toHaveBeenCalled();
  });
});

describe('transcribeUtterance', () => {
  it('聞き取れたら文字を返す', async () => {
    const deps = createDeps({ transcribe: async () => '今日の天気を教えて' });

    expect(await transcribeUtterance(deps, utterance)).toEqual({
      kind: 'heard',
      text: '今日の天気を教えて',
    });
  });

  it('空で返ったら「聞き取れなかった」— 失敗ではない', async () => {
    // 2 秒に満たない発話にはエンジンが空を返す（→ D-16 の追記の 3）。
    const deps = createDeps({ transcribe: async () => '' });

    expect(await transcribeUtterance(deps, utterance)).toEqual({
      kind: 'not-heard',
    });
    expect(deps.log.info).toHaveBeenCalled();
  });

  it('エンジンが落ちていても投げず、ログに残す', async () => {
    const deps = createDeps({
      transcribe: async () => {
        throw new Error('時間切れ');
      },
    });

    const outcome = await transcribeUtterance(deps, utterance);

    expect(outcome.kind).toBe('unavailable');
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it('文字起こしが設定されていなければ、そう返す', async () => {
    expect(await transcribeUtterance(createDeps(), utterance)).toEqual({
      kind: 'not-configured',
    });
  });
});
