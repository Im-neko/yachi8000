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
    inConversationWindow: false,
    mentionsSomeoneElse: false,
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

  it('連続会話の窓の中なら、メンション無しでも応答する', () => {
    expect(shouldRespond(context({ inConversationWindow: true }))).toBe(true);
  });

  it('窓の中でも、別の誰かへ宛てた発言には応答しない', () => {
    expect(
      shouldRespond(
        context({ inConversationWindow: true, mentionsSomeoneElse: true }),
      ),
    ).toBe(false);
  });

  it('アシスタントへのメンションがあれば、他の人へのメンションが付いていても応答する', () => {
    expect(
      shouldRespond(
        context({ mentionsAssistant: true, mentionsSomeoneElse: true }),
      ),
    ).toBe(true);
  });

  it('Bot の発言には窓の中でも応答しない', () => {
    expect(
      shouldRespond(context({ inConversationWindow: true, authorIsBot: true })),
    ).toBe(false);
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
