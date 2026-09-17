import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatCompleter } from './chat-completion.ts';

const completer = createChatCompleter({
  baseUrl: 'https://proxy.example/v1',
  apiKey: 'k',
  model: 'm',
  label: '通知の書き換え',
});

function respondWith(body: unknown, init: ResponseInit = {}): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      ...init,
    }),
  );
}

function completion(content: string | null) {
  return { choices: [{ message: { content } }] };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createChatCompleter', () => {
  it('本文を取り出して前後の空白を落とす', async () => {
    respondWith(completion('  書き換えました。  '));
    await expect(
      completer({ system: 's', user: 'u', maxLength: 100 }),
    ).resolves.toBe('書き換えました。');
  });

  // 縮退の判断は呼び出し側。ここで既定文へ倒すと、縮退が誰にも見えなくなる。
  it('HTTP が失敗したら投げる', async () => {
    respondWith(completion('x'), { status: 503, statusText: 'Unavailable' });
    await expect(
      completer({ system: 's', user: 'u', maxLength: 100 }),
    ).rejects.toThrow(/通知の書き換えに失敗しました: 503/);
  });

  it('形の違う応答は投げる', async () => {
    respondWith({ choices: [] });
    await expect(
      completer({ system: 's', user: 'u', maxLength: 100 }),
    ).rejects.toThrow(/応答を解釈できませんでした/);
  });

  it('空の結果は投げる（空文字を読み上げても何も起きない）', async () => {
    respondWith(completion('   '));
    await expect(
      completer({ system: 's', user: 'u', maxLength: 100 }),
    ).rejects.toThrow(/結果が空でした/);
    respondWith(completion(null));
    await expect(
      completer({ system: 's', user: 'u', maxLength: 100 }),
    ).rejects.toThrow(/結果が空でした/);
  });

  it('長すぎる結果は投げる', async () => {
    respondWith(completion('あ'.repeat(101)));
    await expect(
      completer({ system: 's', user: 'u', maxLength: 100 }),
    ).rejects.toThrow(/結果が長すぎます（101 文字）/);
  });

  it('system と user を分けて送る（データと指示を混ぜない。INV-4）', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(completion('ok')), { status: 200 }),
      );

    await completer({
      system: '規則',
      user: '{"body":"データ"}',
      maxLength: 10,
    });

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe('https://proxy.example/v1/chat/completions');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'm',
      messages: [
        { role: 'system', content: '規則' },
        { role: 'user', content: '{"body":"データ"}' },
      ],
    });
  });
});
