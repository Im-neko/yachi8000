import type { MemoryRecord, MemorySearchHit } from '../memory.ts';
import type { SpeakerId } from '../speaker.ts';

export interface RememberInput {
  content: string;
  speakerId?: SpeakerId | undefined;
}

export interface RecallInput {
  query: string;
  limit: number;
  /**
   * この人が言ったものだけに絞る。既定（undefined）は全体から引く。
   *
   * **絞るのは呼び出し側が明示したときだけ**（→ D-35, F-05）。記憶はひとつの
   * 空間で、話者は分離の鍵ではなく属性。
   */
  speakerId?: SpeakerId | undefined;
}

/**
 * 長期記憶の保存先（F-30）。
 *
 * **テナントでは分けない**（→ D-35）。入れ物は全体でひとつで、「誰の話か」は
 * `speakerId` を列として持つだけ。
 */
export interface MemoryStore {
  remember(input: RememberInput): Promise<MemoryRecord>;
  recall(input: RecallInput): Promise<MemorySearchHit[]>;
  list(limit: number): Promise<MemoryRecord[]>;
  /** 消せたら true、無ければ false。 */
  forget(id: string): Promise<boolean>;
}
