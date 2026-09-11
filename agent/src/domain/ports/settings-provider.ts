import type { Settings } from '../settings.ts';

/**
 * 静的設定の読み出し（F-60）。
 *
 * 設定 UI が動いている間に書き換わるので、起動時に 1 度読んで固定しない。
 * エージェントの render から同期で呼ぶため、この port も同期。
 */
export interface SettingsProvider {
  get(): Settings;
}
