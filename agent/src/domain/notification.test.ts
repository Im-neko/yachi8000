import { describe, expect, it } from 'vitest';
import { composeNotificationFallback } from './notification.ts';

describe('composeNotificationFallback', () => {
  it('送信元と本文をそのまま埋める', () => {
    expect(
      composeNotificationFallback({
        source: 'claude-code',
        body: '作業が完了しました。',
      }),
    ).toBe('claude-code からのメッセージです。作業が完了しました。');
  });

  // 並列に動かしていると「おわりました」だけでは何が終わったか分からない。
  it('役割があれば送信元に添えて読む', () => {
    expect(
      composeNotificationFallback({
        source: 'claude-code',
        role: 'レビュー担当',
        body: 'おわりました',
      }),
    ).toBe('claude-code（レビュー担当） からのメッセージです。おわりました');
  });

  // role は送信元が名乗る値で検証しない。source（トークンから決まる）と
  // 見た目を混ぜないことで、認証している側の意味を保つ（F-18）。
  it('空白だけの役割は無いものとして扱う', () => {
    expect(
      composeNotificationFallback({
        source: 'ci',
        role: '   ',
        body: '通りました',
      }),
    ).toBe('ci からのメッセージです。通りました');
  });
});
