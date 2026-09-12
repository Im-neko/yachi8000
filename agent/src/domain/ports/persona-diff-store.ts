import type { PersonaDiff } from '../persona.ts';
import type { TenantId } from '../tenant.ts';

export interface RecordPersonaDiffInput {
  tenantId: TenantId;
  /** 応答に追加で効かせる指示。 */
  instruction: string;
  /** 何を契機に変わったか（F-33）。 */
  reason: string;
}

/**
 * 人格の変化差分（F-33）の読み書き。
 *
 * エージェントの render はプロンプトを同期で組み立てるので、この port も
 * 同期にする。実装は SQLite（`node:sqlite` は同期ドライバ）。
 *
 * **巻き戻しは行を消さずに `revertedAt` を立てる。** F-33 が求めるのは
 * 「いつ・何が・どのやり取りを契機に変わったか」の記録で、消してしまうと
 * 「なぜそうなったのか分からないまま戻せなくなる」を自分でやることになる。
 */
export interface PersonaDiffStore {
  /** 巻き戻されていない差分を、記録順に返す。 */
  list(tenantId: TenantId): readonly PersonaDiff[];
  /** 巻き戻したものも含めて履歴を新しい順に返す（F-33 の「変化の一覧」）。 */
  history(tenantId: TenantId, limit: number): readonly PersonaDiffRecord[];
  record(input: RecordPersonaDiffInput): PersonaDiff;
  /** 巻き戻せたら true、そのテナントに無い / 既に巻き戻し済みなら false。 */
  revert(tenantId: TenantId, id: string): boolean;
  /** 既定の人格まで一括で巻き戻し、戻した件数を返す。 */
  revertAll(tenantId: TenantId): number;
}

export interface PersonaDiffRecord extends PersonaDiff {
  /** 巻き戻し済みなら ISO 8601。効いているなら undefined。 */
  revertedAt: string | undefined;
}
