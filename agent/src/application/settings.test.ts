import { describe, expect, it, vi } from 'vitest';
import type { SettingsSaveResult } from '../domain/ports/settings-editor.ts';
import type { EditableSettings } from '../domain/settings.ts';
import {
  type SettingsEditDependencies,
  updateEditableSettings,
} from './settings.ts';

const current: EditableSettings = {
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

function setup(
  options: { speakers?: () => Promise<{ id: number; label: string }[]> } = {},
) {
  const saved: EditableSettings[] = [];
  const deps: SettingsEditDependencies = {
    editor: {
      read: () => ({ version: '1', settings: current }),
      save: (_version, next): SettingsSaveResult => {
        saved.push(next);
        return { kind: 'saved', version: '2', settings: next };
      },
    },
    synthesizer: {
      synthesize: () => {
        throw new Error('使わない');
      },
      verifyContract: async () => undefined,
      listSpeakers:
        options.speakers ?? (async () => [{ id: 3, label: 'A（ふつう）' }]),
    },
    log: { info: vi.fn(), warn: vi.fn() },
  };
  return { deps, saved };
}

describe('updateEditableSettings', () => {
  it('エンジンに無い話者は保存しない', async () => {
    const { deps, saved } = setup();

    const result = await updateEditableSettings(deps, {
      version: '1',
      settings: { ...current, voice: { ...current.voice, speakerId: 99 } },
      changedBy: 'someone',
    });

    expect(result).toEqual({ kind: 'unknown-speaker', speakerId: 99 });
    expect(saved).toEqual([]);
  });

  it('話者を変えていなければ、エンジンが落ちていても保存できる', async () => {
    // 声と関係のない変更（固定モードの ON）まで道連れにしない。
    const { deps, saved } = setup({
      speakers: async () => {
        throw new Error('エンジンに繋がりません');
      },
    });

    const result = await updateEditableSettings(deps, {
      version: '1',
      settings: {
        ...current,
        behavior: { ...current.behavior, personaLock: true },
      },
      changedBy: undefined,
    });

    expect(result.kind).toBe('saved');
    expect(saved).toHaveLength(1);
  });

  it('話者を変えるときにエンジンへ確かめられなければ保存しない', async () => {
    const { deps, saved } = setup({
      speakers: async () => {
        throw new Error('エンジンに繋がりません');
      },
    });

    const result = await updateEditableSettings(deps, {
      version: '1',
      settings: { ...current, voice: { ...current.voice, speakerId: 8 } },
      changedBy: undefined,
    });

    expect(result.kind).toBe('speakers-unavailable');
    expect(saved).toEqual([]);
    expect(deps.log.warn).toHaveBeenCalled();
  });
});
