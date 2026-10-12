import * as v from 'valibot';
import type { MetricSample } from '../../domain/ops.ts';

const QUERY_TIMEOUT_MS = 45_000;

const VectorResponseSchema = v.object({
  status: v.literal('success'),
  data: v.object({
    resultType: v.string(),
    result: v.array(v.unknown()),
  }),
});

const VectorSampleSchema = v.object({
  metric: v.record(v.string(), v.string()),
  value: v.tuple([v.number(), v.string()]),
});

/**
 * Prometheus と Loki の即時クエリは、同じ形（`vector`）で答える。
 *
 * **形が違うときは投げる。** 黙って空にすると、API の仕様が変わっても
 * 「何も無かった」ことになり、見回りが「異常なし」と言い続ける。
 */
export function parseInstantVector(
  body: unknown,
  label: string,
): MetricSample[] {
  const parsed = v.safeParse(VectorResponseSchema, body);
  if (!parsed.success) {
    throw new Error(
      `${label}の応答を解釈できませんでした: ${v.summarize(parsed.issues)}`,
    );
  }
  if (parsed.output.data.resultType !== 'vector') {
    throw new Error(
      `${label}は集計クエリ（vector）を返す必要があります（結果の種類: ${parsed.output.data.resultType}）。`,
    );
  }

  const samples: MetricSample[] = [];
  for (const raw of parsed.output.data.result) {
    const sample = v.safeParse(VectorSampleSchema, raw);
    if (!sample.success) {
      throw new Error(
        `${label}のサンプルを解釈できませんでした: ${v.summarize(sample.issues)}`,
      );
    }
    const value = Number(sample.output.value[1]);
    // NaN は「その時点でデータが無い」。数として扱うと比較が全て偽になる。
    if (Number.isNaN(value)) continue;
    samples.push({ labels: sample.output.metric, value });
  }
  return samples;
}

/**
 * GET して JSON を返す。失敗したときは**応答の本文を添えて**投げる ——
 * Loki はクエリの文法エラーを本文で返すので、チャットで問い合わせた側
 * （エージェント）がクエリを直すのに要る。
 */
export async function getJson(url: URL, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(
      `${label}に失敗しました: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`,
    );
  }
  return response.json();
}
