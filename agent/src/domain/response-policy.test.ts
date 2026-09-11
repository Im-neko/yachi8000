import { describe, expect, it } from 'vitest';
import {
  type IncomingMessageContext,
  shouldRespond,
} from './response-policy.ts';

function context(
  overrides: Partial<IncomingMessageContext> = {},
): IncomingMessageContext {
  return {
    isDirectMessage: false,
    mentionsAssistant: false,
    authorIsBot: false,
    hasText: true,
    ...overrides,
  };
}

describe('shouldRespond', () => {
  it('DM はメンションが無くても応答する', () => {
    expect(shouldRespond(context({ isDirectMessage: true }))).toBe(true);
  });

  it('チャンネルのメンション無しには応答しない', () => {
    expect(shouldRespond(context())).toBe(false);
  });

  it('チャンネルでもメンションされれば応答する', () => {
    expect(shouldRespond(context({ mentionsAssistant: true }))).toBe(true);
  });

  it('Bot の発言には応答しない（DM でもメンションでも）', () => {
    expect(
      shouldRespond(context({ isDirectMessage: true, authorIsBot: true })),
    ).toBe(false);
    expect(
      shouldRespond(context({ mentionsAssistant: true, authorIsBot: true })),
    ).toBe(false);
  });

  it('本文が空なら応答しない', () => {
    expect(
      shouldRespond(context({ isDirectMessage: true, hasText: false })),
    ).toBe(false);
  });
});
