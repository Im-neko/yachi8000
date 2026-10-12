import type { MetricSample } from '../ops.ts';

export interface LogLine {
  /** ナノ秒の Unix 時刻（Loki の値そのまま）。 */
  timestamp: string;
  labels: Readonly<Record<string, string>>;
  line: string;
}

export interface LogLinesQuery {
  /** ログセレクタ（`{namespace="x"} |~ "error"` など）。メトリクスクエリは不可。 */
  logql: string;
  start: Date;
  end: Date;
  limit: number;
}

export interface LogMetricQuery {
  /** メトリクスクエリ（`sum by (x) (count_over_time({...}[24h]))` など）。 */
  logql: string;
  at: Date;
}

/**
 * ログの検索先（F-53）。読むだけ。
 *
 * **取れなかったことと 0 件は別。** 前者は投げる —— 黙って空にすると、
 * 収集が止まっていても「異常なし」になる。
 */
export interface LogSource {
  lines(query: LogLinesQuery): Promise<LogLine[]>;
  metric(query: LogMetricQuery): Promise<MetricSample[]>;
}
