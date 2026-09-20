import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PersonNote, PersonProfile } from '../../domain/person.ts';
import type { PersonProfileStore } from '../../domain/ports/person-profile-store.ts';
import type { SpeakerId } from '../../domain/speaker.ts';

interface ProfileRow {
  speaker_id: string;
  display_name: string;
  first_seen_at: string;
}

interface NoteRow {
  id: string;
  content: string;
  recorded_at: string;
}

/**
 * 話しかけてくる相手のプロフィールの SQLite 実装（F-05）。
 *
 * エージェントの render から同期で読むので同期ドライバを使う（人格差分・
 * スキルと同じ理由）。**鍵は正規化済みの話者 ID** —— 入口の生の ID を
 * そのまま渡されると、同じ人が二重に登録される。
 */
export function createSqlitePersonProfileStore(
  db: DatabaseSync,
): PersonProfileStore {
  const selectProfile = db.prepare(
    `SELECT * FROM person_profiles WHERE speaker_id = ?`,
  );
  const selectNotes = db.prepare(
    `SELECT id, content, recorded_at FROM person_notes
      WHERE speaker_id = ?
      ORDER BY recorded_at ASC`,
  );
  // 初対面のときだけ入る。既にある行は触らない —— 利用者が自分で直した
  // 呼び名を、入口の表示名の変更で潰さないため（F-05）。
  const insertProfile = db.prepare(
    `INSERT OR IGNORE INTO person_profiles
       (speaker_id, display_name, first_seen_at)
     VALUES (?, ?, ?)`,
  );
  const upsertName = db.prepare(
    `INSERT INTO person_profiles (speaker_id, display_name, first_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT (speaker_id) DO UPDATE SET display_name = excluded.display_name`,
  );
  const insertNote = db.prepare(
    `INSERT INTO person_notes (id, speaker_id, content, recorded_at)
     VALUES (?, ?, ?, ?)`,
  );
  const deleteNote = db.prepare(
    `DELETE FROM person_notes WHERE speaker_id = ? AND id = ?`,
  );

  function notesOf(speakerId: SpeakerId): PersonNote[] {
    return (selectNotes.all(speakerId) as unknown as NoteRow[]).map((row) => ({
      id: row.id,
      content: row.content,
      recordedAt: row.recorded_at,
    }));
  }

  function get(speakerId: SpeakerId): PersonProfile | undefined {
    const row = selectProfile.get(speakerId) as unknown as
      | ProfileRow
      | undefined;
    if (!row) return undefined;
    return {
      speakerId,
      displayName: row.display_name,
      notes: notesOf(speakerId),
      firstSeenAt: row.first_seen_at,
    };
  }

  function require(speakerId: SpeakerId): PersonProfile {
    const profile = get(speakerId);
    if (!profile) {
      throw new Error(`プロフィールがありません: ${speakerId}`);
    }
    return profile;
  }

  return {
    get,

    ensure(speakerId: SpeakerId, displayName: string): boolean {
      return (
        insertProfile.run(speakerId, displayName, new Date().toISOString())
          .changes > 0
      );
    },

    rename(speakerId: SpeakerId, displayName: string): PersonProfile {
      upsertName.run(speakerId, displayName, new Date().toISOString());
      return require(speakerId);
    },

    addNote(speakerId: SpeakerId, content: string): PersonNote {
      const note: PersonNote = {
        id: randomUUID(),
        content,
        recordedAt: new Date().toISOString(),
      };
      insertNote.run(note.id, speakerId, note.content, note.recordedAt);
      return note;
    },

    removeNote(speakerId: SpeakerId, noteId: string): boolean {
      return deleteNote.run(speakerId, noteId).changes > 0;
    },
  };
}
