import type { MemoryRecord, MemorySearchHit } from '../domain/memory.ts';
import type { MemoryStore } from '../domain/ports/memory-store.ts';
import type { TenantId } from '../domain/tenant.ts';

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
  input: { tenantId: TenantId; content: string; speakerId?: string },
): Promise<MemoryRecord> {
  const content = input.content.trim();
  if (content === '') {
    throw new Error('長期記憶に空の内容は保存できません。');
  }
  return deps.store.remember({
    tenantId: input.tenantId,
    content,
    speakerId: input.speakerId,
  });
}

export async function recallMemories(
  deps: MemoryDependencies,
  input: { tenantId: TenantId; query: string },
): Promise<MemorySearchHit[]> {
  const query = input.query.trim();
  if (query === '') {
    throw new Error('長期記憶の検索に空のクエリは使えません。');
  }
  return deps.store.recall({
    tenantId: input.tenantId,
    query,
    limit: RECALL_LIMIT,
  });
}

export async function listMemories(
  deps: MemoryDependencies,
  tenantId: TenantId,
): Promise<MemoryRecord[]> {
  return deps.store.list(tenantId, LIST_LIMIT);
}

export async function forgetMemory(
  deps: MemoryDependencies,
  input: { tenantId: TenantId; id: string },
): Promise<boolean> {
  return deps.store.forget(input.tenantId, input.id);
}
