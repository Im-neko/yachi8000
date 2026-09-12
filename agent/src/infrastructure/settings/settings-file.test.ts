import { describe, expect, it } from 'vitest';
import { parseSettingsYaml } from './settings-file.ts';

const valid = `
identity:
  name: やち
  userAddress: あなた
persona:
  firstPerson: わたし
  personality: おだやかで、頼まれたことは最後までやり切る。
  speechStyle: ですます調。
voice:
  speakerId: 3
  speedScale: 1.0
  pitchScale: 0.0
notification:
  whenNotInVoice: drop
behavior:
  personaLock: false
  reminderPollIntervalSeconds: 30
`;

describe('parseSettingsYaml', () => {
  it('妥当な設定を読める', () => {
    const settings = parseSettingsYaml(valid);
    expect(settings.identity.name).toBe('やち');
    expect(settings.behavior.personaLock).toBe(false);
  });

  it('必須項目が欠けていたら落ちる', () => {
    expect(() =>
      parseSettingsYaml(valid.replace('  firstPerson: わたし\n', '')),
    ).toThrow(/検証に失敗/);
  });

  it('空文字は受け付けない', () => {
    expect(() =>
      parseSettingsYaml(valid.replace('name: やち', "name: ''")),
    ).toThrow(/検証に失敗/);
  });

  it('話者 ID が整数でなければ落ちる', () => {
    expect(() =>
      parseSettingsYaml(valid.replace('speakerId: 3', 'speakerId: 3.5')),
    ).toThrow(/検証に失敗/);
  });

  it('whenNotInVoice は text / drop のみ', () => {
    expect(() =>
      parseSettingsYaml(
        valid.replace('whenNotInVoice: drop', 'whenNotInVoice: voice'),
      ),
    ).toThrow(/検証に失敗/);
  });

  it('fallbackChannelId は Discord のスノーフレークのみ', () => {
    expect(() =>
      parseSettingsYaml(
        valid.replace(
          'whenNotInVoice: drop',
          "whenNotInVoice: text\n  fallbackChannelId: 'abc'",
        ),
      ),
    ).toThrow(/検証に失敗/);
  });

  it('personaLock が真偽値でなければ落ちる', () => {
    expect(() =>
      parseSettingsYaml(
        valid.replace('personaLock: false', 'personaLock: いいえ'),
      ),
    ).toThrow(/検証に失敗/);
  });

  it('リマインダーのポーリング間隔は 5 秒以上の整数', () => {
    expect(() =>
      parseSettingsYaml(
        valid.replace(
          'reminderPollIntervalSeconds: 30',
          'reminderPollIntervalSeconds: 1',
        ),
      ),
    ).toThrow(/検証に失敗/);
    expect(() =>
      parseSettingsYaml(
        valid.replace(
          'reminderPollIntervalSeconds: 30',
          'reminderPollIntervalSeconds: 30.5',
        ),
      ),
    ).toThrow(/検証に失敗/);
  });
});
