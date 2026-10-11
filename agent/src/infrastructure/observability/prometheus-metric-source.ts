import type { MetricSource } from '../../domain/ports/metric-source.ts';
import { getJson, parseInstantVector } from './instant-vector.ts';

export interface CreatePrometheusMetricSourceInput {
  /** Prometheus のベース URL（`/api/v1` の手前まで）。 */
  baseUrl: string;
}

/** Prometheus の即時クエリ（F-53）。読むだけ。 */
export function createPrometheusMetricSource(
  input: CreatePrometheusMetricSourceInput,
): MetricSource {
  const base = input.baseUrl.replace(/\/$/, '');

  return {
    async instant({ promql, at }) {
      const url = new URL(`${base}/api/v1/query`);
      url.searchParams.set('query', promql);
      url.searchParams.set('time', String(at.getTime() / 1000));
      return parseInstantVector(
        await getJson(url, 'メトリクスの問い合わせ'),
        'メトリクスの問い合わせ',
      );
    },
  };
}
