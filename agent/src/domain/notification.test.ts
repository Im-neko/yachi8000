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
});
