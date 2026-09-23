import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionFailure } from '../../domain/ports/transcriber.ts';
import { createWhisperTranscriber } from './whisper-transcriber.ts';

const utterance = {
  bytes: new Uint8Array(new ArrayBuffer(4)),
  contentType: 'audio/webm',
};

function stubFetch(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createWhisperTranscriber', () => {
  it('言語を必ず渡す（付けないと判定に 1.3 秒かかる → D-48 の 4）', async () => {
    const fetchMock = stubFetch(Response.json({ text: 'こんにちは' }));
    const transcriber = createWhisperTranscriber({
      baseUrl: 'http://proxy/v1/',
      apiKey: 'key',
      model: 'local-whisper-small',
    });

    expect(await transcriber.transcribe(utterance)).toBe('こんにちは');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    // 末尾のスラッシュは畳む。二重スラッシュで 404 になる経路を作らない。
    expect(url).toBe('http://proxy/v1/audio/transcriptions');
    const form = init.body as FormData;
    expect(form.get('language')).toBe('ja');
    expect(form.get('model')).toBe('local-whisper-small');
  });

  it('429 は枠切れとして投げる（「落ちている」と混ぜない → Q-29）', async () => {
    stubFetch(new Response('rate limit exceeded', { status: 429 }));
    const transcriber = createWhisperTranscriber({
      baseUrl: 'http://proxy/v1',
      apiKey: 'key',
      model: 'm',
    });

    await expect(transcriber.transcribe(utterance)).rejects.toMatchObject({
      name: 'TranscriptionFailure',
      reason: 'rate-limited',
    });
  });

  it('文字起こし以外のモデルを指していたら、そう言って落ちる', async () => {
    stubFetch(Response.json({ choices: [] }));
    const transcriber = createWhisperTranscriber({
      baseUrl: 'http://proxy/v1',
      apiKey: 'key',
      model: 'gpt-5.6-luna',
    });

    await expect(transcriber.transcribe(utterance)).rejects.toBeInstanceOf(
      TranscriptionFailure,
    );
  });
});
