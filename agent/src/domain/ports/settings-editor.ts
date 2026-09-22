import type { EditableSettings } from '../settings.ts';

/** 保存の結果。**起こりうる断りは型で並べる**（例外は想定外の故障だけ）。 */
export type SettingsSaveResult =
  | { kind: 'saved'; version: string; settings: EditableSettings }
  /** 読み出してから誰かが（手編集でも UI でも）書き換えた。 */
  | { kind: 'conflict' }
  /** 設定ファイルに `avatar` 節が無いのに、アバターの値が来た。 */
  | { kind: 'avatar-not-configured' }
  /** 書き戻した結果が設定として成立しない。**保存はしていない。** */
  | { kind: 'invalid'; message: string };

/**
 * 静的設定の書き換え（F-61）。
 *
 * **`SettingsProvider` とは別の port にしてある**（→ D-44）。読む口は
 * エージェント・ツール・poller・音声合成が持っているので、そこに書く手が
 * 生えると「会話ロジックは設定ファイルへ書かない」（INV-9）が規約だけの
 * 約束になる。**この port を渡すのは設定 UI のハンドラだけ。**
 */
export interface SettingsEditor {
  /**
   * 編集できる部分と、書き戻すときに使う版を返す。
   *
   * 版を持ち回るのは**手編集と UI の同時変更で失われる書き込みを出さない**
   * ため（F-61）。読み出した後に中身が変わっていれば保存を断る。
   */
  read(): { version: string; settings: EditableSettings };

  /**
   * 読み直し → 検証 → 保存を **1 操作**で行う（F-61）。
   *
   * **同期にしてあるのは、途中に待ちを挟まないため。** Node は 1 スレッドで
   * 走るので、await が無い限り他のリクエストが割り込めない —— 読み直しと
   * 保存の間に他の書き込みが入る余地を、作りの側で消してある。
   */
  save(version: string, settings: EditableSettings): SettingsSaveResult;
}
