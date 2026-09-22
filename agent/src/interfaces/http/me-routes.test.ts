import { createChannelRouter } from '@flue/runtime';
import { describe, expect, it, vi } from 'vitest';
import type { VoiceInputDependencies } from '../../application/voice-input.ts';
import type { Settings } from '../../domain/settings.ts';
import { createMeRoutes } from './me-routes.ts';

function createApp() {
  const deps: VoiceInputDependencies = {
    settings: {
      get: () =>
        ({
          web: { speakers: { yuki: 'discord-user-123456789' } },
        }) as unknown as Settings,
    },
    log: { info: vi.fn(), warn: vi.fn() },
  };
  return createChannelRouter(createMeRoutes(deps));
}

describe('createMeRoutes', () => {
  it('対応表にいる人には話者 ID も返す', async () => {
    const response = await createApp().request('/me', {
      headers: { 'x-authentik-username': 'yuki' },
    });

    expect(await response.json()).toEqual({
      username: 'yuki',
      speakerId: 'discord-user-123456789',
    });
  });

  it('対応表に無くても名乗りは返す（それを見て対応表を書く）', async () => {
    const response = await createApp().request('/me', {
      headers: { 'x-authentik-username': 'stranger' },
    });

    expect(await response.json()).toEqual({
      username: 'stranger',
      speakerId: null,
    });
  });

  it('名乗りが届いていなければ、その旨が分かる', async () => {
    const response = await createApp().request('/me');

    expect(await response.json()).toEqual({ username: null, speakerId: null });
  });
});
