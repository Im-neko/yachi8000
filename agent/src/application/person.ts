import {
  normalizeDisplayName,
  type PersonNote,
  type PersonProfile,
} from '../domain/person.ts';
import type { PersonProfileStore } from '../domain/ports/person-profile-store.ts';
import type { SpeakerId } from '../domain/speaker.ts';

export interface PersonDependencies {
  store: PersonProfileStore;
  log: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
  };
}

/**
 * 初めて見た相手を覚える（F-05）。**どの入口も、ターンの頭で必ず呼ぶ。**
 *
 * 毎回名乗らせないための自動登録で、**既にある行は触らない** ——
 * 利用者が自分で直した呼び名を、入口の表示名の変更で潰さない。
 *
 * 表示名は**本人以外も変えられる文字列**で、そのままシステムプロンプトへ
 * 入る。通らない名前は**登録しない**（INV-4 と同じ理由）。名前が無いままでも
 * 会話は続くので、落とさずに WARN を出す（INV-7）。
 */
export function ensureSpeakerProfile(
  deps: PersonDependencies,
  input: { speakerId: SpeakerId; displayName: string },
): void {
  const displayName = normalizeDisplayName(input.displayName);
  if (displayName === undefined) {
    deps.log.warn(
      { speakerId: input.speakerId },
      'Rejected a display name — the speaker stays unnamed',
    );
    return;
  }
  if (deps.store.ensure(input.speakerId, displayName)) {
    deps.log.info(
      { speakerId: input.speakerId },
      'Met someone for the first time',
    );
  }
}

export function speakerProfile(
  deps: PersonDependencies,
  speakerId: SpeakerId,
): PersonProfile | undefined {
  return deps.store.get(speakerId);
}

/** 呼び名を明示的に変える（F-05）。以後は入口の表示名では上書きされない。 */
export function renameSpeaker(
  deps: PersonDependencies,
  input: { speakerId: SpeakerId; displayName: string },
): PersonProfile {
  const displayName = normalizeDisplayName(input.displayName);
  if (displayName === undefined) {
    throw new Error(
      'その呼び名は使えません（空・長すぎる・制御文字を含む、のいずれか）。',
    );
  }
  const profile = deps.store.rename(input.speakerId, displayName);
  deps.log.info({ speakerId: input.speakerId }, 'Renamed a speaker');
  return profile;
}

/**
 * 相手について覚える（F-05）。
 *
 * **長期記憶（F-30）とは使い分ける。** ここに入れるのは「この人と話す
 * ときに毎回効いてほしいこと」だけ —— 検索されずに毎ターン載るので、
 * 何でも入れるとコンテキストをプロフィールで埋める。
 */
export function rememberAboutSpeaker(
  deps: PersonDependencies,
  input: { speakerId: SpeakerId; content: string },
): PersonNote {
  const content = input.content.trim();
  if (content === '') {
    throw new Error('空の内容はプロフィールに保存できません。');
  }
  if (deps.store.get(input.speakerId) === undefined) {
    throw new Error(
      `プロフィールのない相手には保存できません: ${input.speakerId}`,
    );
  }
  const note = deps.store.addNote(input.speakerId, content);
  deps.log.info(
    { speakerId: input.speakerId, noteId: note.id },
    'Recorded something about a speaker',
  );
  return note;
}

export function forgetAboutSpeaker(
  deps: PersonDependencies,
  input: { speakerId: SpeakerId; noteId: string },
): boolean {
  return deps.store.removeNote(input.speakerId, input.noteId);
}
