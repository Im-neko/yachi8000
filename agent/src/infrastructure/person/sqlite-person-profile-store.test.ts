import { beforeEach, describe, expect, it } from 'vitest';
import type { PersonProfileStore } from '../../domain/ports/person-profile-store.ts';
import type { SpeakerId } from '../../domain/speaker.ts';
import { openAppDatabase } from '../db/app-database.ts';
import { createSqlitePersonProfileStore } from './sqlite-person-profile-store.ts';

const A = 'discord-user-1' as SpeakerId;
const B = 'discord-user-2' as SpeakerId;

describe('createSqlitePersonProfileStore', () => {
  let store: PersonProfileStore;

  beforeEach(() => {
    store = createSqlitePersonProfileStore(openAppDatabase(':memory:'));
  });

  it('初対面のときだけ作る', () => {
    expect(store.ensure(A, 'ゆい')).toBe(true);
    expect(store.ensure(A, 'ゆい')).toBe(false);
    expect(store.get(A)?.displayName).toBe('ゆい');
  });

  // 利用者が自分で直した呼び名を、入口の表示名の変更で潰さない（F-05）。
  it('既にある呼び名は自動登録で上書きされない', () => {
    store.ensure(A, 'ゆい');
    store.rename(A, 'ゆいさん');
    store.ensure(A, 'べつの表示名');
    expect(store.get(A)?.displayName).toBe('ゆいさん');
  });

  it('知らない相手は undefined', () => {
    expect(store.get(A)).toBeUndefined();
  });

  it('メモは記録順に並ぶ', () => {
    store.ensure(A, 'ゆい');
    store.addNote(A, '猫を飼っている');
    store.addNote(A, '朝は弱い');
    expect(store.get(A)?.notes.map((n) => n.content)).toEqual([
      '猫を飼っている',
      '朝は弱い',
    ]);
  });

  it('他の人のメモは混ざらない', () => {
    store.ensure(A, 'ゆい');
    store.ensure(B, 'ほか');
    store.addNote(A, 'A のこと');
    expect(store.get(B)?.notes).toHaveLength(0);
  });

  it('他の人のメモは消せない', () => {
    store.ensure(A, 'ゆい');
    store.ensure(B, 'ほか');
    const note = store.addNote(A, 'A のこと');
    expect(store.removeNote(B, note.id)).toBe(false);
    expect(store.removeNote(A, note.id)).toBe(true);
    expect(store.get(A)?.notes).toHaveLength(0);
  });

  it('呼び名を変えてもメモは残る', () => {
    store.ensure(A, 'ゆい');
    store.addNote(A, '猫を飼っている');
    expect(store.rename(A, 'ゆいさん').notes).toHaveLength(1);
  });
});
