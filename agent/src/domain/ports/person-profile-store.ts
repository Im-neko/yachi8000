import type { PersonNote, PersonProfile } from '../person.ts';
import type { SpeakerId } from '../speaker.ts';

/**
 * 話しかけてくる相手のプロフィール（F-05）の読み書き。
 *
 * エージェントの render はプロンプトを同期で組み立てるので、この port も
 * 同期にする（人格差分・スキルと同じ理由）。実装は SQLite。
 *
 * **テナントでは分けない**（→ D-35）。入れ物は全体でひとつで、鍵は話者。
 */
export interface PersonProfileStore {
  get(speakerId: SpeakerId): PersonProfile | undefined;
  /**
   * 初対面なら表示名とともに作る。**既にあれば何もしない** ——
   * 利用者が自分で直した呼び名を、入口の表示名の変更で潰さない（F-05）。
   *
   * @returns 作ったら true。
   */
  ensure(speakerId: SpeakerId, displayName: string): boolean;
  /** 呼び名を明示的に変える。行が無ければ作る。 */
  rename(speakerId: SpeakerId, displayName: string): PersonProfile;
  addNote(speakerId: SpeakerId, content: string): PersonNote;
  /** 消せたら true、その人に無ければ false。 */
  removeNote(speakerId: SpeakerId, noteId: string): boolean;
}
