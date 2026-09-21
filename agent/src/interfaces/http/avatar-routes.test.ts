import { createChannelRouter } from '@flue/runtime';
import { describe, expect, it, vi } from 'vitest';
import type { AvatarDependencies } from '../../application/avatar.ts';
import type { AvatarEvent } from '../../domain/avatar-event.ts';
import type { Settings } from '../../domain/settings.ts';
import { createAvatarRoutes } from './avatar-routes.ts';

const CONFIGURED = {
  avatar: {
    vrmPath: '/data/avatar.vrm',
    idleExpression: 'happy',
    camera: { targetHeight: 1.3, distance: 1.5 },
  },
} as unknown as Settings;

function createHarness(settings: Settings = CONFIGURED) {
  const subscribers: {
    listener: (event: AvatarEvent) => void;
    audio: boolean;
    close?: () => void;
  }[] = [];

  const deps: AvatarDependencies = {
    settings: { get: () => settings },
    models: { read: async () => undefined },
    events: {
      subscribe: (
        listener: (event: AvatarEvent) => void,
        options: { audio: boolean; onClose?: () => void },
      ) => {
        subscribers.push({
          listener,
          audio: options.audio,
          close: options.onClose,
        });
        listener({ kind: 'state', state: 'idle' });
        return () => undefined;
      },
      listeningBrowsers: () => 0,
    },
    audio: { put: () => 'id', get: () => new Uint8Array([1, 2, 3, 4]) },
    log: { warn: vi.fn() },
  } as unknown as AvatarDependencies;

  return {
    app: createChannelRouter(createAvatarRoutes(deps)),
    subscribers,
    log: deps.log,
  };
}

/**
 * **実際のリクエストで確かめる。** 本番でアバターの API が丸ごと 404 に
 * なっていたのは、ルートを一度もリクエストで通していなかったから。
 */
describe('createAvatarRoutes', () => {
  it('表示設定を返す', async () => {
    const { app } = createHarness();
    const response = await app.request('/avatar/config');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      idleExpression: 'happy',
      camera: { targetHeight: 1.3, distance: 1.5 },
      // 素材を置いていなければ空。ブラウザは何も読み込まない（F-25）。
      gestures: [],
    });
  });

  it('設定が無ければ 404（置かれていない、とは別の理由を返す）', async () => {
    const { app } = createHarness({} as unknown as Settings);
    const response = await app.request('/avatar/config');

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('設定されていません');
  });

  it('VRM が置かれていなければ 404。置き場所は応答に載せない', async () => {
    const { app, log } = createHarness();
    const response = await app.request('/avatar/model');

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('/data/avatar.vrm');
    expect(log.warn).toHaveBeenCalled();
  });

  // ID はクエリで受ける（チャンネルルーターがパスを文字列一致で引くため）。
  it('読み上げた音を WAV で返す', async () => {
    const { app } = createHarness();
    const response = await app.request('/avatar/speech?id=abc');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    // 間に立つものに会話の音を持たせない。
    expect(response.headers.get('cache-control')).toBe('no-store');
    const wav = new Uint8Array(await response.arrayBuffer());
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
  });

  it('発話イベントを SSE で流し、繋いだ直後に今の状態を出す', async () => {
    const { app } = createHarness();
    const response = await app.request('/avatar/events');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body?.getReader();
    if (!reader) throw new Error('本文がありません');
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain('event: state');
    expect(chunk).toContain('"state":"idle"');
    await reader.cancel();
  });

  // 開いたままの配信が停止をぶら下げないこと（→ D-38 の 5）。
  it('打ち切られたら配信を終える', async () => {
    const { app, subscribers } = createHarness();
    const response = await app.request('/avatar/events');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('本文がありません');
    await reader.read();

    expect(subscribers).toHaveLength(1);
    expect(subscribers[0]?.close).toBeTypeOf('function');
    subscribers[0]?.close?.();

    // 打ち切ると本文が閉じる（＝ Flue が持っている lease が外れる）。
    await expect(
      (async () => {
        while (!(await reader.read()).done) {
          // 閉じるまで読み進める
        }
      })(),
    ).resolves.toBeUndefined();
  });

  it('知らないパスは 404', async () => {
    const { app } = createHarness();
    expect((await app.request('/avatar/nope')).status).toBe(404);
  });
});
