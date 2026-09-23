import { createChannelRouter } from '@flue/runtime';
import { describe, expect, it, vi } from 'vitest';
import type { SpeechService } from '../../application/speech.ts';
import type { VoiceInputDependencies } from '../../application/voice-input.ts';
import { TranscriptionFailure } from '../../domain/ports/transcriber.ts';
import type { Settings } from '../../domain/settings.ts';
import { createMicRoutes } from './mic-routes.ts';

const SPEAKERS = { yuki: 'discord-user-123456789' };

function createHarness(
  options: { transcribe?: () => Promise<string>; reply?: string } = {},
) {
  const spoken: unknown[] = [];
  const turns: unknown[] = [];
  const voiceInput: VoiceInputDependencies = {
    settings: {
      get: () => ({ web: { speakers: SPEAKERS } }) as unknown as Settings,
    },
    transcriber: {
      transcribe: options.transcribe ?? (async () => 'こんにちは'),
    },
    log: { info: vi.fn(), warn: vi.fn() },
  };
  const speech = {
    speak: (input: unknown) => spoken.push(input),
    canSpeak: () => true,
    pending: () => 0,
  } as unknown as SpeechService;

  const app = createChannelRouter(
    createMicRoutes({
      voiceInput,
      speech,
      runTurn: async (input) => {
        turns.push(input);
        return options.reply ?? 'はい、こんにちは。';
      },
    }),
  );
  return { app, spoken, turns };
}

function post(
  body: Uint8Array,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'audio/webm',
      'x-authentik-username': 'yuki',
      ...headers,
    },
    body,
  };
}

const audio = new Uint8Array([1, 2, 3, 4]);

describe('createMicRoutes', () => {
  it('聞き取って返事をし、読み上げへ回す', async () => {
    const { app, spoken, turns } = createHarness();

    const response = await app.request('/mic/utterance', post(audio));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      heard: true,
      transcript: 'こんにちは',
      reply: 'はい、こんにちは。',
    });
    // 会話は話者ごとに分かれ、Discord の DM とは別（→ D-47）。
    expect(turns).toHaveLength(1);
    expect((turns[0] as { conversationId: string }).conversationId).toBe(
      'web-123456789',
    );
    // 出口の判定は発話側が持つ。ここは出どころだけを言う（→ D-40）。
    expect(spoken).toEqual([
      {
        text: 'はい、こんにちは。',
        priority: 'reply',
        origin: { kind: 'web-conversation' },
      },
    ]);
  });

  it('対応表に無い人は断り、名乗りをそのまま返す', async () => {
    const { app, turns } = createHarness();

    const response = await app.request(
      '/mic/utterance',
      post(audio, { 'x-authentik-username': 'stranger' }),
    );

    expect(response.status).toBe(403);
    expect(turns).toEqual([]);
    // **対応表は手で書くもの**なので、書くために自分の名前が要る。
    expect(await response.json()).toMatchObject({ username: 'stranger' });
  });

  it('利用者名が届いていなければ断る', async () => {
    const { app } = createHarness();

    const response = await app.request('/mic/utterance', {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: audio,
    });

    expect(response.status).toBe(403);
  });

  it('知らない形式は受けない', async () => {
    const { app } = createHarness();

    const response = await app.request(
      '/mic/utterance',
      post(audio, { 'content-type': 'application/json' }),
    );

    expect(response.status).toBe(415);
  });

  it('形式に文字コードが付いていても受ける', async () => {
    // MediaRecorder は `audio/webm;codecs=opus` を名乗る。
    const { app } = createHarness();

    const response = await app.request(
      '/mic/utterance',
      post(audio, { 'content-type': 'audio/webm;codecs=opus' }),
    );

    expect(response.status).toBe(200);
  });

  it('空で返ったら「聞き取れなかった」を返し、ターンを回さない', async () => {
    const { app, turns, spoken } = createHarness({
      transcribe: async () => '',
    });

    const response = await app.request('/mic/utterance', post(audio));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      heard: false,
      transcript: null,
      reply: null,
    });
    expect(turns).toEqual([]);
    expect(spoken).toEqual([]);
  });

  it('エンジンが落ちていたら 503 で理由を返す', async () => {
    const { app } = createHarness({
      transcribe: async () => {
        throw new Error('時間切れ');
      },
    });

    const response = await app.request('/mic/utterance', post(audio));

    expect(response.status).toBe(503);
  });

  it('枠を使い切っていたら 429 で「落ちている」と区別して返す', async () => {
    const { app } = createHarness({
      transcribe: async () => {
        throw new TranscriptionFailure(
          '文字起こしの利用枠を使い切っています。',
          'rate-limited',
        );
      },
    });

    const response = await app.request('/mic/utterance', post(audio));

    // **503 と分ける。** 待てば直ると読めてしまうと、翌月まで押し続ける
    // ことになる（→ Q-29）。
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ rateLimited: true });
  });

  it('空の音声は受けない', async () => {
    const { app } = createHarness();

    const response = await app.request(
      '/mic/utterance',
      post(new Uint8Array(0)),
    );

    expect(response.status).toBe(400);
  });
});
