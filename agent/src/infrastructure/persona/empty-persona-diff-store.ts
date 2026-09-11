import type { PersonaDiff } from '../../domain/persona.ts';
import type { PersonaDiffStore } from '../../domain/ports/persona-diff-store.ts';

const NONE: readonly PersonaDiff[] = Object.freeze([]);

/**
 * 人格差分をまだ 1 件も持たない実装。
 *
 * 差分の**記録**（F-33）はスキル自己改善ループと同じフェーズで作る。
 * それまでは、応答側の合成経路（静的設定 + 差分）だけを先に通しておく。
 * 合成を後から足す形にすると、固定モード（F-34）の分岐が後付けになり、
 * 「差分を読まない」という決定的な防御が抜ける。
 */
export function createEmptyPersonaDiffStore(): PersonaDiffStore {
  return {
    list: () => NONE,
  };
}
