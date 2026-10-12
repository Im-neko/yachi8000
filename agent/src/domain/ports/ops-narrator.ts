import type { OpsFinding } from '../ops.ts';

export interface OpsNarrationMaterial {
  /** JST の日付（`YYYY-MM-DD`）。 */
  day: string;
  findings: readonly OpsFinding[];
  /** 傾向を判定できなかった理由。伝えるべき制約として渡す。 */
  notes: readonly string[];
}

/**
 * 見つかったものを、アシスタントの口調の文章にする（F-53）。
 *
 * 項目の有無も重大度も決めない。言葉にするだけ（INV-3）。材料のログ行は
 * 外部が書いたデータとして渡す（INV-4）。失敗したら投げ、縮退と WARN は
 * 呼び出し側が決める。
 */
export interface OpsNarrator {
  narrate(material: OpsNarrationMaterial): Promise<string>;
}
