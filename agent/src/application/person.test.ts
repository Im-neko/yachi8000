import { beforeEach, describe, expect, it } from 'vitest';
import type { PersonNote, PersonProfile } from '../domain/person.ts';
import type { PersonProfileStore } from '../domain/ports/person-profile-store.ts';
import type { SpeakerId } from '../domain/speaker.ts';
import {
  ensureSpeakerProfile,
  type PersonDependencies,
  rememberAboutSpeaker,
  renameSpeaker,
  speakerProfile,
} from './person.ts';

const SPEAKER = 'discord-user-1' as SpeakerId;

/**
 * PersonProfileStore の代役。
 *
 * **SQL 側の契約は `infrastructure/person/sqlite-person-profile-store.test.ts`
 * が受け持つ。** ここで確かめるのは、表示名の検査と「上書きしない」という
 * ユースケースの判断（F-05）。
 */
function createFakeStore(): PersonProfileStore {
  const profiles = new Map<string, PersonProfile>();
  let nextId = 0;

  return {
    get: (speakerId) => profiles.get(speakerId),

    ensure(speakerId, displayName) {
      if (profiles.has(speakerId)) return false;
      profiles.set(speakerId, {
        speakerId,
        displayName,
        notes: [],
        firstSeenAt: '2026-09-20T00:00:00.000Z',
      });
      return true;
    },

    rename(speakerId, displayName) {
      const current = profiles.get(speakerId);
      const next: PersonProfile = current
        ? { ...current, displayName }
        : {
            speakerId,
            displayName,
            notes: [],
            firstSeenAt: '2026-09-20T00:00:00.000Z',
          };
      profiles.set(speakerId, next);
      return next;
    },

    addNote(speakerId, content) {
      const current = profiles.get(speakerId);
      if (!current) throw new Error('プロフィールがありません');
      const note: PersonNote = {
        id: `n${++nextId}`,
        content,
        recordedAt: '2026-09-20T00:00:00.000Z',
      };
      profiles.set(speakerId, { ...current, notes: [...current.notes, note] });
      return note;
    },

    removeNote(speakerId, noteId) {
      const current = profiles.get(speakerId);
      if (!current) return false;
      const notes = current.notes.filter((note) => note.id !== noteId);
      if (notes.length === current.notes.length) return false;
      profiles.set(speakerId, { ...current, notes });
      return true;
    },
  };
}

describe('ensureSpeakerProfile', () => {
  let deps: PersonDependencies;
  let warnings: number;

  beforeEach(() => {
    warnings = 0;
    deps = {
      store: createFakeStore(),
      log: {
        info: () => undefined,
        warn: () => {
          warnings += 1;
        },
      },
    };
  });

  it('初対面の表示名を覚える', () => {
    ensureSpeakerProfile(deps, { speakerId: SPEAKER, displayName: 'ゆい' });
    expect(speakerProfile(deps, SPEAKER)?.displayName).toBe('ゆい');
  });

  // 表示名は本人以外も変えられる文字列で、そのままシステムプロンプトへ入る。
  // 落とさずに続けるが、黙っては済ませない（INV-7）。
  it('通らない表示名は登録せず、WARN を出す', () => {
    ensureSpeakerProfile(deps, {
      speakerId: SPEAKER,
      displayName: 'ゆ\u0000い',
    });
    expect(speakerProfile(deps, SPEAKER)).toBeUndefined();
    expect(warnings).toBe(1);
  });

  it('自分で決めた呼び名を、あとの表示名で上書きしない', () => {
    ensureSpeakerProfile(deps, { speakerId: SPEAKER, displayName: 'ゆい' });
    renameSpeaker(deps, { speakerId: SPEAKER, displayName: 'ゆいさん' });
    ensureSpeakerProfile(deps, {
      speakerId: SPEAKER,
      displayName: 'べつの表示名',
    });
    expect(speakerProfile(deps, SPEAKER)?.displayName).toBe('ゆいさん');
  });
});

describe('renameSpeaker', () => {
  it('通らない呼び名は拒む（黙って無視しない）', () => {
    const deps: PersonDependencies = {
      store: createFakeStore(),
      log: { info: () => undefined, warn: () => undefined },
    };
    expect(() =>
      renameSpeaker(deps, { speakerId: SPEAKER, displayName: '  ' }),
    ).toThrow(/使えません/);
  });
});

describe('rememberAboutSpeaker', () => {
  let deps: PersonDependencies;

  beforeEach(() => {
    deps = {
      store: createFakeStore(),
      log: { info: () => undefined, warn: () => undefined },
    };
    ensureSpeakerProfile(deps, { speakerId: SPEAKER, displayName: 'ゆい' });
  });

  it('覚えた内容がプロフィールに載る', () => {
    rememberAboutSpeaker(deps, {
      speakerId: SPEAKER,
      content: '猫を飼っている',
    });
    expect(speakerProfile(deps, SPEAKER)?.notes.map((n) => n.content)).toEqual([
      '猫を飼っている',
    ]);
  });

  it('空の内容は拒む', () => {
    expect(() =>
      rememberAboutSpeaker(deps, { speakerId: SPEAKER, content: '  ' }),
    ).toThrow(/空の内容/);
  });

  // 誰のものか決まらないメモを残さない。
  it('知らない相手には保存できない', () => {
    expect(() =>
      rememberAboutSpeaker(deps, {
        speakerId: 'discord-user-404' as SpeakerId,
        content: 'x',
      }),
    ).toThrow(/プロフィールのない/);
  });
});
