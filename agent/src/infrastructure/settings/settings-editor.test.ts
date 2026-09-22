import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EditableSettings } from '../../domain/settings.ts';
import { createSettingsFileEditor } from './settings-file.ts';

/**
 * 手で書いた設定ファイルに近い形。**コメント・長い説明・UI が知らない節**を
 * わざと混ぜてある —— 保存で消えてはいけないものが揃っている。
 */
const source = `# yachi8000 の静的設定。
identity:
  # アシスタントの名前。
  name: やち
persona:
  firstPerson: わたし
  personality: |
    おだやかで落ち着いている。
    分からないことは分からないと言う。
  speechStyle: |
    ですます調。語尾を伸ばさない。
avatar:
  vrmPath: ./data/avatar.vrm
  idleExpression: neutral
  camera:
    targetHeight: 1.3
    distance: 1.5
  gestures:
    nod: ./data/motions/nod.vrma
  attribution: "誰かの素材"
voice:
  speakerId: 3
  speedScale: 1.0
  pitchScale: 0.0
notification:
  whenNoOutput: drop
  # UI が知らない節。消してはいけない。
  channels:
    money:
      guildId: "000000000000000001"
      channelId: "000000000000000002"
issueTracker:
  repositories:
    "000000000000000003": owner/repository
behavior:
  personaLock: false
  reminderPollIntervalSeconds: 30
`;

function place(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'yachi-settings-')), 'a.yaml');
  writeFileSync(path, source, 'utf8');
  return path;
}

function edited(base: EditableSettings): EditableSettings {
  return {
    ...base,
    identity: { name: 'やち改' },
    persona: { ...base.persona, personality: 'あかるい。\nよく笑う。\n' },
    voice: { ...base.voice, speedScale: 1.2 },
    behavior: { ...base.behavior, personaLock: true },
  };
}

describe('createSettingsFileEditor', () => {
  it('編集できる範囲だけを返す（パスとチャンネル ID は含まない）', () => {
    const { settings } = createSettingsFileEditor(place()).read();

    expect(settings.avatar).toEqual({
      idleExpression: 'neutral',
      camera: { targetHeight: 1.3, distance: 1.5 },
    });
    expect(settings.notification).toEqual({ whenNoOutput: 'drop' });
    expect(Object.keys(settings)).not.toContain('issueTracker');
  });

  it('保存してもコメントと UI が知らない節が残る', () => {
    const path = place();
    const editor = createSettingsFileEditor(path);
    const { version, settings } = editor.read();

    const result = editor.save(version, edited(settings));

    expect(result.kind).toBe('saved');
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('# yachi8000 の静的設定。');
    expect(written).toContain('# アシスタントの名前。');
    expect(written).toContain('# UI が知らない節。消してはいけない。');
    expect(written).toContain('owner/repository');
    expect(written).toContain('./data/motions/nod.vrma');
    expect(written).toContain('name: やち改');
    expect(written).toContain('personaLock: true');
  });

  it('複数行の説明はブロックのまま書き戻す（手で開いて読める形）', () => {
    const path = place();
    const editor = createSettingsFileEditor(path);
    const { version, settings } = editor.read();

    editor.save(version, edited(settings));

    expect(readFileSync(path, 'utf8')).toContain(
      'personality: |\n    あかるい。\n    よく笑う。\n',
    );
  });

  it('読んだあとに書き換わっていたら保存しない', () => {
    const path = place();
    const editor = createSettingsFileEditor(path);
    const { version, settings } = editor.read();

    // 手編集が割り込んだ状況。mtime が動くよう中身も変える。
    writeFileSync(
      path,
      source.replace('name: やち', 'name: 手で変えた'),
      'utf8',
    );

    expect(editor.save(version, edited(settings)).kind).toBe('conflict');
    expect(readFileSync(path, 'utf8')).toContain('name: 手で変えた');
  });

  it('設定として成立しない値は書かずに断る', () => {
    const path = place();
    const editor = createSettingsFileEditor(path);
    const { version, settings } = editor.read();

    const result = editor.save(version, {
      ...settings,
      // スキーマの範囲外（0.5〜2.0）。**書いてから落とすのでは遅い。**
      voice: { ...settings.voice, speedScale: 9 },
    });

    expect(result.kind).toBe('invalid');
    expect(readFileSync(path, 'utf8')).toBe(source);
  });

  it('avatar 節が無い設定へアバターの値は書かない', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'yachi-settings-')), 'a.yaml');
    writeFileSync(
      path,
      source.slice(0, source.indexOf('avatar:')) +
        source.slice(source.indexOf('voice:')),
      'utf8',
    );
    const editor = createSettingsFileEditor(path);
    const { version, settings } = editor.read();

    expect(settings.avatar).toBeUndefined();
    const result = editor.save(version, {
      ...settings,
      avatar: {
        idleExpression: 'happy',
        camera: { targetHeight: 1, distance: 1 },
      },
    });

    expect(result.kind).toBe('avatar-not-configured');
  });

  it('保存すると版が変わる（続けて 2 回保存できる）', () => {
    const path = place();
    const editor = createSettingsFileEditor(path);
    const first = editor.read();

    const saved = editor.save(first.version, edited(first.settings));
    expect(saved.kind).toBe('saved');
    if (saved.kind !== 'saved') return;

    expect(editor.save(saved.version, saved.settings).kind).toBe('saved');
    expect(editor.save(first.version, saved.settings).kind).toBe('conflict');
  });
});
