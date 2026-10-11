import * as v from 'valibot';
import type { LogLine, LogSource } from '../../domain/ports/log-source.ts';
import { getJson, parseInstantVector } from './instant-vector.ts';

export interface CreateLokiLogSourceInput {
  /** Loki のベース URL（`/loki/api/v1` の手前まで）。 */
  baseUrl: string;
}

const StreamsResponseSchema = v.object({
  status: v.literal('success'),
  data: v.object({
    resultType: v.literal('streams'),
    result: v.array(
      v.object({
        stream: v.record(v.string(), v.string()),
        values: v.array(v.tuple([v.string(), v.string()])),
      }),
    ),
  }),
});

/** ミリ秒の時刻を Loki が受けるナノ秒の文字列にする。 */
function toNanoseconds(date: Date): string {
  return `${date.getTime()}000000`;
}

/** Loki のログ・集計クエリ（F-53）。読むだけ。 */
export function createLokiLogSource(
  input: CreateLokiLogSourceInput,
): LogSource {
  const base = input.baseUrl.replace(/\/$/, '');

  return {
    async lines({ logql, start, end, limit }) {
      const url = new URL(`${base}/loki/api/v1/query_range`);
      url.searchParams.set('query', logql);
      url.searchParams.set('start', toNanoseconds(start));
      url.searchParams.set('end', toNanoseconds(end));
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('direction', 'backward');

      const parsed = v.safeParse(
        StreamsResponseSchema,
        await getJson(url, 'ログの問い合わせ'),
      );
      if (!parsed.success) {
        throw new Error(
          `ログの問い合わせの応答を解釈できませんでした（集計クエリは mode=metric で）: ${v.summarize(parsed.issues)}`,
        );
      }

      const lines: LogLine[] = parsed.output.data.result.flatMap((stream) =>
        stream.values.map(([timestamp, line]) => ({
          timestamp,
          labels: stream.stream,
          line,
        })),
      );
      // ストリームごとに新しい順で返るので、全体で並べ直して件数を切る。
      return lines
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
        .slice(0, limit);
    },

    async metric({ logql, at }) {
      const url = new URL(`${base}/loki/api/v1/query`);
      url.searchParams.set('query', logql);
      url.searchParams.set('time', toNanoseconds(at));
      return parseInstantVector(await getJson(url, 'ログの集計'), 'ログの集計');
    },
  };
}
