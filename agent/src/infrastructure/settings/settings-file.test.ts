import { describe, expect, it } from 'vitest';
import { parseSettingsYaml } from './settings-file.ts';

const valid = `
identity:
  name: やち
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

// アバターは任意（→ F-20）。フェーズ 5 までの設定ファイルには avatar が
// 無いので、必須にすると稼働中の Pod が上がらなくなる。
const withAvatar = `${valid}
avatar:
  vrmPath: ./data/avatar.vrm
  idleExpression: happy
  camera:
    targetHeight: 1.3
    distance: 1.5
`;

describe('parseSettingsYaml', () => {
  it('avatar が無くても読める（任意の節）', () => {
    expect(parseSettingsYaml(valid).avatar).toBeUndefined();
  });

  it('avatar を読める', () => {
    expect(parseSettingsYaml(withAvatar).avatar).toEqual({
      vrmPath: './data/avatar.vrm',
      idleExpression: 'happy',
      camera: { targetHeight: 1.3, distance: 1.5 },
    });
  });

  // モデル固有の blendshape 名を書かれても three-vrm 側で解決できない。
  // 設定の時点で落とす（→ D-36 の 1）。
  it('プリセットに無い表情は受け付けない', () => {
    expect(() =>
      parseSettingsYaml(
        withAvatar.replace(
          'idleExpression: happy',
          'idleExpression: Fcl_ALL_Joy',
        ),
      ),
    ).toThrow(/検証に失敗/);
  });

  it('妥当な設定を読める', () => {
    const settings = parseSettingsYaml(valid);
    expect(settings.identity.name).toBe('やち');
    expect(settings.behavior.personaLock).toBe(false);
  });

  // 本番の設定ファイルは PVC 上にあり、ArgoCD の管理外で手で置かれている
  // （deploy.md）。`userAddress` を落としたとき（→ D-35, F-05）に古いファイルで
  // 起動が止まらないことを、ここで押さえておく。
  it('知らない項目は無視する（古い設定ファイルで起動が止まらない）', () => {
    const settings = parseSettingsYaml(
      valid.replace('  name: やち', '  name: やち\n  userAddress: あなた'),
    );
    expect(settings.identity.name).toBe('やち');
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

  it('名前で選べる配信先を読める', () => {
    const settings = parseSettingsYaml(
      valid.replace(
        'whenNotInVoice: drop',
        "whenNotInVoice: drop\n  channels:\n    money:\n      guildId: '111111111111111111'\n      channelId: '222222222222222222'",
      ),
    );
    expect(settings.notification.channels?.money).toEqual({
      guildId: '111111111111111111',
      channelId: '222222222222222222',
    });
  });

  // ギルド ID を併せて持つのは、読み上げを同じサーバのときだけに絞るため（D-31）。
  it('配信先にギルド ID が無ければ落ちる', () => {
    expect(() =>
      parseSettingsYaml(
        valid.replace(
          'whenNotInVoice: drop',
          "whenNotInVoice: drop\n  channels:\n    money:\n      channelId: '222222222222222222'",
        ),
      ),
    ).toThrow(/検証に失敗/);
  });

  it('宛先の名前は英小文字・数字・ハイフンのみ', () => {
    expect(() =>
      parseSettingsYaml(
        valid.replace(
          'whenNotInVoice: drop',
          "whenNotInVoice: drop\n  channels:\n    お金:\n      guildId: '111111111111111111'\n      channelId: '222222222222222222'",
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
