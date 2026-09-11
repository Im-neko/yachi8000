import type { TenantId } from './tenant.ts';

/**
 * 長期記憶の 1 件（F-30）。
 *
 * 会話の短中期記憶は Flue の永続化と自動圧縮に任せ、ここには
 * **明示的に記録された事実だけ**を置く。毎ターン自動で書き込まない。
 */
export interface MemoryRecord {
  id: string;
  tenantId: TenantId;
  /** 記録した内容。 */
  content: string;
  /** 誰についての / 誰が言った記憶か。分からなければ undefined。 */
  speakerId: string | undefined;
  /** ISO 8601。 */
  recordedAt: string;
}

export interface MemorySearchHit extends MemoryRecord {
  /** コサイン類似度（1 が最も近い）。 */
  score: number;
}
