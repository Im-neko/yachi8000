import { createChannelRouter } from '@flue/runtime';
import { describe, expect, it, vi } from 'vitest';
import type { SettingsEditDependencies } from '../../application/settings.ts';
import type { SettingsSaveResult } from '../../domain/ports/settings-editor.ts';
import type { EditableSettings } from '../../domain/settings.ts';
import { createSettingsRoutes } from './settings-routes.ts';

const CURRENT: EditableSettings = {
  identity: { name: 'やち' },
  persona: {
    firstPerson: 'わたし',
    personality: 'おだやか。\n',
    speechStyle: 'ですます調。\n',
  },
  voice: { speakerId: 3, speedScale: 1, pitchScale: 0 },
  notification: { whenNoOutput: 'drop' },
  behavior: { personaLock: false, reminderPollIntervalSeconds: 30 },
};

function createHarness(
  save: (version: string, next: EditableSettings) => SettingsSaveResult = (
    _version,
    next,
  ) => ({ kind: 'saved', version: '2', settings: next }),
) {
  const saved: EditableSettings[] = [];
  const deps: SettingsEditDependencies = {
    editor: {
      read: () => ({ version: '1', settings: CURRENT }),
      save: (version, next) => {
        saved.push(next);
        return save(version, next);
      },
    },
    synthesizer: {
      synthesize: () => {
        throw new Error('使わない');
      },
      verifyContract: async () => undefined,
      listSpeakers: async () => [{ id: 3, label: 'A（ふつう）' }],
    },
    log: { info: vi.fn(), warn: vi.fn() },
  };
  return { app: createChannelRouter(createSettingsRoutes(deps)), saved };
}

function put(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

describe('createSettingsRoutes', () => {
  it('編集できる範囲と版を返す', async () => {
    const response = await createHarness().app.request('/settings');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: '1',
      settings: CURRENT,
    });
  });

  it('声の一覧を返す', async () => {
    const response = await createHarness().app.request('/settings/voices');

    expect(await response.json()).toEqual({
      speakers: [{ id: 3, label: 'A（ふつう）' }],
    });
  });

  it('保存する', async () => {
    const { app, saved } = createHarness();

    const response = await app.request(
      '/settings',
      put({
        version: '1',
        settings: { ...CURRENT, identity: { name: 'やち改' } },
      }),
    );

    expect(response.status).toBe(200);
    expect(saved[0]?.identity.name).toBe('やち改');
    // 複数行の説明は末尾に改行が付いた形で渡る（設定ファイルでブロックに
    // 書き戻せるように）。
    expect(saved[0]?.persona.personality).toBe('おだやか。\n');
  });

  it('JSON だと名乗らない要求は受けない', async () => {
    const { app, saved } = createHarness();

    const response = await app.request('/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: JSON.stringify({ version: '1', settings: CURRENT }),
    });

    expect(response.status).toBe(415);
    expect(saved).toEqual([]);
  });

  it('範囲の外の値は保存に回さない', async () => {
    const { app, saved } = createHarness();

    const response = await app.request(
      '/settings',
      put({
        version: '1',
        settings: {
          ...CURRENT,
          behavior: { ...CURRENT.behavior, reminderPollIntervalSeconds: 1 },
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(saved).toEqual([]);
  });

  it('版が古ければ 409 を返す', async () => {
    const { app } = createHarness(() => ({ kind: 'conflict' }));

    const response = await app.request(
      '/settings',
      put({ version: '0', settings: CURRENT }),
    );

    expect(response.status).toBe(409);
  });

  it('VRM のパスは受け取らない（送られても無視する）', async () => {
    const { app, saved } = createHarness();

    await app.request(
      '/settings',
      put({
        version: '1',
        settings: {
          ...CURRENT,
          avatar: {
            idleExpression: 'happy',
            camera: { targetHeight: 1.3, distance: 1.5 },
            vrmPath: '/etc/passwd',
          },
        },
      }),
    );

    expect(saved[0]?.avatar).toEqual({
      idleExpression: 'happy',
      camera: { targetHeight: 1.3, distance: 1.5 },
    });
  });
});
