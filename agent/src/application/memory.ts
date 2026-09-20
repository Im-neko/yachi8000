import type { MemoryRecord, MemorySearchHit } from '../domain/memory.ts';
import type { MemoryStore } from '../domain/ports/memory-store.ts';
import type { SpeakerId } from '../domain/speaker.ts';

export interface MemoryDependencies {
  store: MemoryStore;
}

/** 1 回の想起で読み出す最大件数。 */
const RECALL_LIMIT = 5;
/** 一覧で返す最大件数。 */
const LIST_LIMIT = 50;

/**
 * 長期記憶へ明示的に書き出す（F-30）。
 *
 * 会話履歴は Flue の自動圧縮で落ちていくので、残したい事実はここを
 * 通さないと消える。逆に、毎ターンの自動書き込みはしない。
 */
export async function rememberFact(
  deps: MemoryDependencies,
  input: { content: string; speakerId?: SpeakerId },
): Promise<MemoryRecord> {
  const content = input.content.trim();
  if (content === '') {
    throw new Error('長期記憶に空の内容は保存できません。');
  }
  return deps.store.remember({ content, speakerId: input.speakerId });
}

/**
 * 長期記憶を想起する（F-30）。
 *
 * **既定は全体から引く**（→ D-35, F-05）。`speakerId` を渡したときだけ
 * 「その人が言ったこと」に絞る —— 誰が言ったかで常に閉じると、人から
 * 聞いた話を別の人に答えられなくなる。
 */
export async function recallMemories(
  deps: MemoryDependencies,
  input: { query: string; speakerId?: SpeakerId },
): Promise<MemorySearchHit[]> {
  const query = input.query.trim();
  if (query === '') {
    throw new Error('長期記憶の検索に空のクエリは使えません。');
  }
  return deps.store.recall({
    query,
    limit: RECALL_LIMIT,
    speakerId: input.speakerId,
  });
}

export async function listMemories(
  deps: MemoryDependencies,
): Promise<MemoryRecord[]> {
  return deps.store.list(LIST_LIMIT);
}

export async function forgetMemory(
  deps: MemoryDependencies,
  id: string,
): Promise<boolean> {
  return deps.store.forget(id);
}
