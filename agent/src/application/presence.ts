import {
  aggregatePresence,
  type Presence,
  type PresenceReport,
} from '../domain/presence.ts';

/**
 * 「人がいるか」を 1 箇所で持つ（F-26）。
 *
 * **ランタイム状態で、残さない。** 見ている人がいなくなれば消えてよい情報で、
 * 再起動をまたいで覚えておく意味が無い（覚えていると、起動直後に
 * 「誰もいない部屋に人がいる」ことになる）。
 */
export interface PresenceService {
  /** ブラウザからの報告。**報告者ごとに上書き**する。 */
  report(reporterId: string, state: Presence): void;
  /** まとめた今の状態。 */
  current(): Presence;
}

export function createPresenceService(now: () => number): PresenceService {
  const reports = new Map<string, PresenceReport>();

  return {
    report(reporterId, state) {
      reports.set(reporterId, { state, at: now() });
    },
    current: () => aggregatePresence(reports.values(), now()),
  };
}
