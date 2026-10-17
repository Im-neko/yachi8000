import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../../domain/settings.ts';
import { createOpsNarrator } from './ops-narrator.ts';

const settings = {
  get: () =>
    ({
      persona: { firstPerson: 'わたし', personality: '', speechStyle: '丁寧' },
    }) as unknown as Settings,
};

const narrator = createOpsNarrator({
  baseUrl: 'https://proxy.example/v1',
  apiKey: 'test-key',
  model: 'm',
  settings,
});

const material = {
  day: '2026-10-17',
  findings: [
    { id: 'a', severity: 'warning' as const, title: 't', detail: 'd' },
  ],
  notes: [],
};

function reply(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createOpsNarrator', () => {
  it('長すぎたら、長さを伝えて 1 度だけ撮り直す', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply('あ'.repeat(1_584)))
      .mockResolvedValueOnce(reply('短い報告'));

    await expect(narrator.narrate(material)).resolves.toBe('短い報告');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const retry = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body));
    expect(retry.messages[0].content).toContain('前回の出力は 1584 字');
  });

  it('撮り直しても長ければ投げる（縮退は呼び出し側が WARN つきで行う）', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => reply('あ'.repeat(1_600)));

    await expect(narrator.narrate(material)).rejects.toThrow(/長すぎます/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('長さ以外の失敗は撮り直さない', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('x', { status: 500 }));

    await expect(narrator.narrate(material)).rejects.toThrow(/500/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
