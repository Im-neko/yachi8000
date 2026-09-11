import type { MemoryRecord, MemorySearchHit } from '../memory.ts';
import type { TenantId } from '../tenant.ts';

export interface RememberInput {
  tenantId: TenantId;
  content: string;
  speakerId?: string | undefined;
}

export interface RecallInput {
  tenantId: TenantId;
  query: string;
  limit: number;
}

/**
 * 長期記憶の保存先（F-30）。テナント分離は実装側が必ず `tenant_id` の
 * 絞り込みとして行う —— 呼び出し側にフィルタを任せない。
 */
export interface MemoryStore {
  remember(input: RememberInput): Promise<MemoryRecord>;
  recall(input: RecallInput): Promise<MemorySearchHit[]>;
  list(tenantId: TenantId, limit: number): Promise<MemoryRecord[]>;
  /** 消せたら true、そのテナントに無ければ false。 */
  forget(tenantId: TenantId, id: string): Promise<boolean>;
}
