import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpsHypothesizer } from './ops-hypothesizer.ts';

const hypothesizer = createOpsHypothesizer({
  baseUrl: 'https://proxy.example/v1',
  apiKey: 'test-key',
  model: 'm',
});

const material = {
  day: '2026-10-17',
  items: [
    {
      findingId: 'error-surge:home/kernel',
      title: 't',
      detail: 'd',
      facts: ['10-16 03:10（JST）ごろから'],
      evidence: ['3× WARNING smsdvb'],
    },
  ],
};

function reply(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const GOOD = {
  findingId: 'error-surge:home/kernel',
  text: 'ドライバの入れ替えが引き金のようです。',
  confidence: 'medium',
  unverified: 'モジュールの版',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createOpsHypothesizer', () => {
  it('項目ごとの見立てを、型を確かめて返す', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      reply(JSON.stringify([GOOD])),
    );

    await expect(hypothesizer.hypothesize(material)).resolves.toEqual([GOOD]);
  });

  it('コードブロックで囲まれて返ってきても読む', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      reply(`\`\`\`json\n${JSON.stringify([GOOD])}\n\`\`\``),
    );

    await expect(hypothesizer.hypothesize(material)).resolves.toHaveLength(1);
  });

  it('渡していない項目への見立てと、同じ項目の重複は捨てる（項目を足させない）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      reply(
        JSON.stringify([
          GOOD,
          { ...GOOD, text: '2 つ目' },
          { ...GOOD, findingId: 'error-surge:other' },
        ]),
      ),
    );

    const results = await hypothesizer.hypothesize(material);

    expect(results.map((r) => r.text)).toEqual([GOOD.text]);
  });

  it('材料のログ行の秘密は、モデルへ渡す前に伏せる', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(reply('[]'));

    await hypothesizer.hypothesize({
      ...material,
      items: [
        { ...material.items[0], evidence: ['Bearer abcdef0123456789xyz'] },
      ] as never,
    });

    const body = String(fetchSpy.mock.calls[0]?.[1]?.body);
    expect(body).not.toContain('abcdef0123456789xyz');
  });

  it('JSON でない応答と、形の違う応答は投げる（呼び出し側が縮退して WARN を出す）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(reply('原因は不明です'));
    await expect(hypothesizer.hypothesize(material)).rejects.toThrow(
      /JSON ではありませんでした/,
    );

    fetchSpy.mockResolvedValueOnce(
      reply(JSON.stringify([{ ...GOOD, confidence: 'certain' }])),
    );
    await expect(hypothesizer.hypothesize(material)).rejects.toThrow(
      /解釈できませんでした/,
    );
  });
});
