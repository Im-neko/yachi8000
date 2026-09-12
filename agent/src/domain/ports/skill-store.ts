import type {
  SkillCandidate,
  SkillKind,
  SkillProposal,
  SkillStatus,
} from '../skill.ts';
import type { TenantId } from '../tenant.ts';

export interface ProposeSkillInput extends SkillProposal {
  tenantId: TenantId;
}

/**
 * スキル候補の保存先（F-40〜F-43）。
 *
 * 書き手はキュレーターエージェント（提案）と承認操作の 2 つ。提案は
 * fire-and-forget で非同期に来るので、**承認との競合は「状態遷移を
 * 現在の状態で条件付ける」ことで決める**（`from` に合致する行だけを動かす）。
 * 後から来た提案が承認済みの行を pending に戻すことはない。
 *
 * エージェントの render から同期で読むので port も同期。
 */
export interface SkillStore {
  /** 同名が既にあれば投げる。却下済みの名前も残っているので衝突する。 */
  propose(input: ProposeSkillInput): SkillCandidate;
  list(
    tenantId: TenantId,
    statuses: readonly SkillStatus[],
  ): readonly SkillCandidate[];
  get(tenantId: TenantId, id: string): SkillCandidate | undefined;
  /**
   * 状態を遷移させる。`from` のいずれかに合致する行だけを動かす。
   *
   * @returns 遷移後の候補。合致する行が無ければ undefined。
   */
  transition(
    tenantId: TenantId,
    id: string,
    from: readonly SkillStatus[],
    to: SkillStatus,
  ): SkillCandidate | undefined;
  /** pending を一括で却下し、却下した件数を返す（F-43）。 */
  rejectAllPending(tenantId: TenantId): number;
  /** approved かつ指定の種別のものを、提案順に返す。応答へマウントする対象。 */
  mountable(
    tenantId: TenantId,
    kinds: readonly SkillKind[],
  ): readonly SkillCandidate[];
}
