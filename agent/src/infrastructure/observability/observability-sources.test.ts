import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLokiLogSource } from './loki-log-source.ts';
import { createPrometheusMetricSource } from './prometheus-metric-source.ts';

function respondWith(body: unknown, init: ResponseInit = {}) {
  return vi.fn(
    async (_url: URL, _init?: RequestInit): Promise<Response> =>
      new Response(
        typeof body === 'string' ? body : JSON.stringify(body),
        init,
      ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const AT = new Date('2026-10-12T00:00:00.000Z');

describe('createPrometheusMetricSource', () => {
  const source = createPrometheusMetricSource({
    baseUrl: 'http://prometheus.example:9090/',
  });

  it('即時クエリを投げ、ラベルと値を返す', async () => {
    const fetchMock = respondWith({
      status: 'success',
      data: {
        resultType: 'vector',
        result: [
          { metric: { job: 'node' }, value: [1791763200, '0.93'] },
          { metric: { job: 'gone' }, value: [1791763200, 'NaN'] },
        ],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const samples = await source.instant({ promql: 'up == 0', at: AT });

    const url = fetchMock.mock.calls[0]?.[0];
    expect(url?.toString()).toContain(
      'http://prometheus.example:9090/api/v1/query?',
    );
    expect(url?.searchParams.get('query')).toBe('up == 0');
    expect(url?.searchParams.get('time')).toBe('1791763200');
    // NaN は「その時点でデータが無い」ので数えない。
    expect(samples).toEqual([{ labels: { job: 'node' }, value: 0.93 }]);
  });

  it('0 件と取れなかったことを区別する（失敗は投げる）', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith('bad query', { status: 400, statusText: 'Bad Request' }),
    );
    await expect(source.instant({ promql: '???', at: AT })).rejects.toThrow(
      /400 Bad Request — bad query/,
    );
  });

  it('形が違う応答は投げる（黙って空にしない）', async () => {
    vi.stubGlobal('fetch', respondWith({ status: 'success', data: {} }));
    await expect(source.instant({ promql: 'up', at: AT })).rejects.toThrow(
      /解釈できませんでした/,
    );
  });

  it('スカラーなどベクトルでない結果は投げる', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith({
        status: 'success',
        data: { resultType: 'scalar', result: [] },
      }),
    );
    await expect(source.instant({ promql: '1', at: AT })).rejects.toThrow(
      /vector/,
    );
  });
});

describe('createLokiLogSource', () => {
  const source = createLokiLogSource({ baseUrl: 'http://loki.example:3100' });

  it('ログ行を新しい順に並べ直し、件数で切る', async () => {
    const fetchMock = respondWith({
      status: 'success',
      data: {
        resultType: 'streams',
        result: [
          {
            stream: { pod: 'a' },
            values: [
              ['1700000000000000002', 'a2'],
              ['1700000000000000001', 'a1'],
            ],
          },
          { stream: { pod: 'b' }, values: [['1700000000000000003', 'b3']] },
        ],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const lines = await source.lines({
      logql: '{namespace="x"}',
      start: new Date('2026-10-11T00:00:00.000Z'),
      end: AT,
      limit: 2,
    });

    const url = fetchMock.mock.calls[0]?.[0];
    expect(url?.pathname).toBe('/loki/api/v1/query_range');
    expect(url?.searchParams.get('limit')).toBe('2');
    expect(url?.searchParams.get('direction')).toBe('backward');
    expect(url?.searchParams.get('end')).toBe('1791763200000000000');
    expect(lines.map((l) => l.line)).toEqual(['b3', 'a2']);
    expect(lines[0]?.labels.pod).toBe('b');
  });

  it('集計クエリを lines に投げたときは、metric を使うよう促して投げる', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith({
        status: 'success',
        data: { resultType: 'matrix', result: [] },
      }),
    );
    await expect(
      source.lines({
        logql: 'sum(rate({a="b"}[1m]))',
        start: AT,
        end: AT,
        limit: 1,
      }),
    ).rejects.toThrow(/mode=metric/);
  });

  it('集計は /query に投げ、ベクトルを返す', async () => {
    const fetchMock = respondWith({
      status: 'success',
      data: {
        resultType: 'vector',
        result: [{ metric: { namespace: 'app' }, value: [1, '42'] }],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const samples = await source.metric({
      logql: 'sum by (namespace) (x)',
      at: AT,
    });

    expect(fetchMock.mock.calls[0]?.[0].pathname).toBe('/loki/api/v1/query');
    expect(samples).toEqual([{ labels: { namespace: 'app' }, value: 42 }]);
  });

  it('文法エラーは本文を添えて投げる（問い合わせた側がクエリを直せるように）', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith('parse error at line 1, col 1: syntax error', {
        status: 400,
        statusText: 'Bad Request',
      }),
    );
    await expect(source.metric({ logql: 'oops', at: AT })).rejects.toThrow(
      /parse error at line 1/,
    );
  });
});
