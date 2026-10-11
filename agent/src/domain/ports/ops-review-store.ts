import type { OpsFinding, OpsOverall, OpsSnapshot } from '../ops.ts';

export interface OpsReviewRecord {
  id: string;
  /** 見回りを始めた時刻（ISO 8601）。 */
  reviewedAt: string;
  /** `failed` は見回りそのものが落ちたとき。異常が見つかったこととは別。 */
  status: 'completed' | 'failed';
  severity: OpsOverall;
  findings: OpsFinding[];
  /** 平常の基準になる集計。`failed` のときは無い。 */
  snapshot?: OpsSnapshot;
  /** 言葉にした本文。言葉にできなかったときは無い。 */
  narration?: string;
  error?: string;
  /** 傾向を判定できなかった理由（履歴が足りない、など）。 */
  notes: string[];
}

/** 見回りの結果の置き場（F-53）。ランタイム状態なので SQLite（D-24）。 */
export interface OpsReviewStore {
  save(record: OpsReviewRecord): void;
  latest(): OpsReviewRecord | undefined;
  /** 平常の基準に使う、完了した見回りの集計。新しい順。 */
  recentSnapshots(limit: number): OpsSnapshot[];
}
