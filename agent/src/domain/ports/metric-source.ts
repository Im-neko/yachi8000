import type { MetricSample } from '../ops.ts';

export interface MetricQuery {
  promql: string;
  at: Date;
}

/**
 * メトリクスの問い合わせ先（F-53）。読むだけ。取れなかったときは投げる
 * （`LogSource` と同じ理由）。
 */
export interface MetricSource {
  instant(query: MetricQuery): Promise<MetricSample[]>;
}
