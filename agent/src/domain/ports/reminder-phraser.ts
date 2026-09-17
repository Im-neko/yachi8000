import type { Reminder } from '../reminder.ts';

/**
 * リマインダーを、その場にふさわしい一言へ組み立てる（F-31, D-30）。
 *
 * 毎回同じ定型文（`composeReminderText`）だと会話に馴染まないため、保存した
 * 文面を**素材として**渡し、アシスタントの口調で伝えてもらう。
 *
 * **伝える内容は変えない。** 日時・数値・固有名詞・URL は原文のまま残す
 * —— 言い換えてよいのは「言い方」だけ（→ D-30）。
 *
 * LLM は文面の生成だけを行い、外部システムを操作しない（INV-3）。保存された
 * 文面も、登録者が書いたデータとして渡す（INV-4）。
 */
export interface ReminderPhraser {
  /** 失敗したら投げる。縮退の判断と WARN は呼び出し側（application）。 */
  phrase(reminder: Reminder, firedAt: Date): Promise<string>;
}
