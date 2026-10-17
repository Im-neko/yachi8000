import type { OpsHypothesis } from '../ops-investigation.ts';

export interface HypothesisItem {
  /** 見回りの項目の鍵（`error-surge:<source>`）。結果はこれで突き合わせる。 */
  findingId: string;
  title: string;
  detail: string;
  /** 調書の事実（決定的なコードが数えたもの）。 */
  facts: readonly string[];
  /** ログの代表行。外部が書いたデータ。 */
  evidence: readonly string[];
}

export interface HypothesisMaterial {
  /** JST の日付（`YYYY-MM-DD`）。 */
  day: string;
  items: readonly HypothesisItem[];
}

export interface HypothesisResult extends OpsHypothesis {
  findingId: string;
}

/**
 * 調書を読んで、原因の見立て（推測）を添える（F-54, D-51）。
 *
 * 見立ては事実の説明であって、項目の有無も重大度も変えない（INV-3）。ツールもループも
 * 持たない 1 往復。材料のログ行は外部が書いたデータとして渡す（INV-4）。
 * 失敗したら投げ、縮退と WARN は呼び出し側が決める。
 */
export interface OpsHypothesizer {
  hypothesize(material: HypothesisMaterial): Promise<HypothesisResult[]>;
}
