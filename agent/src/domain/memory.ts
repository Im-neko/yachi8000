import type { SpeakerId } from './speaker.ts';

/**
 * 長期記憶の 1 件（F-30）。
 *
 * 会話の短中期記憶は Flue の永続化と自動圧縮に任せ、ここには
 * **明示的に記録された事実だけ**を置く。毎ターン自動で書き込まない。
 */
export interface MemoryRecord {
  id: string;
  /** 記録した内容。 */
  content: string;
  /**
   * 誰が言った記憶か（F-05）。分からなければ undefined。
   *
   * **分離のための鍵ではなく属性**（→ D-35）。想起は既定で全体から引く ——
   * 誰が言ったかで閉じると、人から聞いた話を別の人に答えられなくなる。
   */
  speakerId: SpeakerId | undefined;
  /** ISO 8601。 */
  recordedAt: string;
}

export interface MemorySearchHit extends MemoryRecord {
  /** コサイン類似度（1 が最も近い）。 */
  score: number;
}
