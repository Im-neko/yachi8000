import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetricSample, OpsSnapshot } from '../domain/ops.ts';
import type { LogSource } from '../domain/ports/log-source.ts';
import type { MetricSource } from '../domain/ports/metric-source.ts';
import type { OpsNarrationMaterial } from '../domain/ports/ops-narrator.ts';
import type {
  OpsReviewRecord,
  OpsReviewStore,
} from '../domain/ports/ops-review-store.ts';
import type { Settings } from '../domain/settings.ts';
import { CONTINUATION_LINE } from './ops-log-queries.ts';
import {
  checkClusterHealth,
  composeReviewMessage,
  MAX_QUERY_LINES,
  type OpsReviewDependencies,
  queryLogLines,
  runDueOpsReview,
  runOpsReview,
} from './ops-review.ts';

// 2026-10-12 09:00 JST
const NOW = new Date('2026-10-12T00:00:00.000Z');

function sample(labels: Record<string, string>, value: number): MetricSample {
  return { labels, value };
}

function createFakeStore(initial: OpsReviewRecord[] = []): OpsReviewStore & {
  records: OpsReviewRecord[];
} {
  const records = [...initial];
  return {
    records,
    save: (record) => {
      records.unshift(record);
    },
    latest: () => records[0],
    recentSnapshots: (limit) =>
      records
        .filter((r) => r.status === 'completed' && r.snapshot)
        .slice(0, limit)
        .map((r) => r.snapshot as OpsSnapshot),
  };
}

function priorReview(day: number, snapshot: OpsSnapshot): OpsReviewRecord {
  return {
    id: `r${day}`,
    reviewedAt: new Date(NOW.getTime() - day * 86_400_000).toISOString(),
    status: 'completed',
    severity: 'ok',
    findings: [],
    snapshot,
    notes: [],
  };
}

const QUIET: OpsSnapshot = {
  errorCounts: { app: 100 },
  clientIps: { '192.0.2.1': 300 },
  statusCounts: { '2xx': 990, '5xx': 10 },
};

/** クエリの部分文字列で応答を選ぶ代役。決めていないクエリは空を返す。 */
function createLogs(
  metric: Record<string, MetricSample[] | Error> = {},
  lines: Array<{ labels: Record<string, string>; line: string }> = [],
): LogSource {
  return {
    metric: async ({ logql }) => {
      // 24 時間は 2 時間ごとの区間に分けて問い合わせるので、最初の区間にだけ答える。
      if (logql.includes('] offset ') && !logql.includes('offset 0h'))
        return [];
      for (const [key, value] of Object.entries(metric)) {
        if (!logql.includes(key)) continue;
        if (value instanceof Error) throw value;
        return value;
      }
      return [];
    },
    lines: async ({ limit }) =>
      lines.slice(0, limit).map((l, i) => ({
        timestamp: String(i),
        labels: l.labels,
        line: l.line,
      })),
  };
}

function createMetrics(
  byQuery: Record<string, MetricSample[] | Error> = {},
): MetricSource {
  return {
    instant: async ({ promql }) => {
      for (const [key, value] of Object.entries(byQuery)) {
        if (!promql.includes(key)) continue;
        if (value instanceof Error) throw value;
        return value;
      }
      return [];
    },
  };
}

function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    identity: { name: 'やち' },
    persona: { firstPerson: 'わたし', personality: '', speechStyle: '' },
    voice: { speakerId: 1, speedScale: 1, pitchScale: 0 },
    notification: {
      whenNoOutput: 'drop',
      channels: { monitoring: { guildId: 'g1', channelId: 'c-mon' } },
    },
    behavior: { personaLock: false, reminderPollIntervalSeconds: 30 },
    ...overrides,
  };
}

function createDeps(
  overrides: Partial<OpsReviewDependencies> = {},
  settings: Settings = baseSettings(),
) {
  const sent: Array<{ channelId: string; text: string }> = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: OpsReviewDependencies = {
    logs: createLogs(),
    metrics: createMetrics(),
    store: createFakeStore(),
    narrator: { narrate: async () => '本文です' },
    hypothesizer: { hypothesize: async () => [] },
    text: {
      send: async (channelId, text) => {
        sent.push({ channelId, text });
      },
    },
    settings: { get: () => settings },
    log,
    ...overrides,
  };
  return { deps, sent, log };
}

const fiveQuietDays = () =>
  [1, 2, 3, 4, 5].map((day) => priorReview(day, QUIET));

describe('runOpsReview', () => {
  it('何も見つからなければ ok で、言葉にする呼び出しもしない', async () => {
    const narrate = vi.fn(async () => 'x');
    const { deps } = createDeps({
      store: createFakeStore(fiveQuietDays()),
      narrator: { narrate },
      logs: createLogs({
        'sum by (namespace)': [sample({ namespace: 'app' }, 110)],
        'sum by (ip)': [sample({ ip: '192.0.2.1' }, 310)],
        'sum by (status)': [
          sample({ status: '200' }, 990),
          sample({ status: '500' }, 10),
        ],
      }),
    });

    const record = await runOpsReview(deps, NOW);

    expect(record.severity).toBe('ok');
    expect(record.findings).toEqual([]);
    expect(record.snapshot).toEqual({
      errorCounts: { app: 110 },
      clientIps: { '192.0.2.1': 310 },
      statusCounts: { '2xx': 990, '5xx': 10 },
    });
    expect(narrate).not.toHaveBeenCalled();
  });

  it('メトリクスのしきい値を超えたものを項目にし、重大度は一番重いもの', async () => {
    const { deps } = createDeps({
      metrics: createMetrics({
        kubelet_volume_stats_used_bytes: [
          sample({ namespace: 'db', persistentvolumeclaim: 'data' }, 0.93),
        ],
        OOMKilled: [sample({ namespace: 'app', pod: 'p', container: 'c' }, 1)],
      }),
    });

    const record = await runOpsReview(deps, NOW);

    expect(record.severity).toBe('critical');
    expect(record.findings.map((f) => f.id)).toEqual([
      'metric:pvc',
      'metric:oom',
    ]);
    expect(record.findings[0]?.detail).toContain('db/data 93%');
  });

  it('5xx の比率の項目に、返している upstream を添える', async () => {
    const { deps } = createDeps({
      logs: createLogs({
        'sum by (status)': [
          sample({ status: '200' }, 700),
          sample({ status: '502' }, 300),
        ],
        'sum by (upstream, status)': [
          sample({ upstream: 'web-api-80', status: '500' }, 20),
          sample({ upstream: 'nginx-nginx-80', status: '502' }, 280),
        ],
      }),
    });

    const record = await runOpsReview(deps, NOW);

    const finding = record.findings.find((f) => f.id === 'status-5xx');
    expect(finding?.detail).toContain(
      '返している upstream: nginx-nginx-80（502）280 件、web-api-80（500）20 件',
    );
  });

  it('upstream の内訳が取れなくても 5xx の項目は残し、注記に出す', async () => {
    const { deps } = createDeps({
      logs: createLogs({
        'sum by (status)': [
          sample({ status: '200' }, 700),
          sample({ status: '502' }, 300),
        ],
        'sum by (upstream, status)': new Error('loki down'),
      }),
    });

    const record = await runOpsReview(deps, NOW);

    expect(record.findings.map((f) => f.id)).toContain('status-5xx');
    expect(record.notes.join()).toContain(
      '5xx を返している upstream を取れなかった',
    );
  });

  it('エラー行の急増を挙げ、代表的なエラー行を添える', async () => {
    const { deps } = createDeps({
      store: createFakeStore(fiveQuietDays()),
      logs: createLogs(
        {
          'sum by (namespace)': [sample({ namespace: 'app' }, 1500)],
          'sum by (ip)': [sample({ ip: '192.0.2.1' }, 300)],
          'sum by (status)': [sample({ status: '200' }, 1000)],
        },
        [
          { labels: { pod: 'p1' }, line: 'connect() failed to 10.0.0.1:80' },
          { labels: { pod: 'p1' }, line: 'connect() failed to 10.0.0.2:80' },
          { labels: { pod: 'p1' }, line: 'password=hunter2 rejected' },
        ],
      ),
    });

    const record = await runOpsReview(deps, NOW);

    const surge = record.findings.find((f) => f.id === 'error-surge:app');
    expect(surge?.severity).toBe('warning');
    expect(surge?.evidence?.[0]).toBe('2× connect() failed to <ip>');
    expect(JSON.stringify(surge?.evidence)).not.toContain('hunter2');
  });

  it('同じ種類の項目が溢れた日は重い順に絞り、削った数を注記する', async () => {
    const namespaces = Array.from({ length: 12 }, (_, i) => `ns${i}`);
    const { deps } = createDeps({
      store: createFakeStore(fiveQuietDays()),
      logs: createLogs({
        'sum by (namespace)': namespaces.map((namespace, i) =>
          sample({ namespace }, 200 + i),
        ),
        'sum by (ip)': [sample({ ip: '192.0.2.1' }, 300)],
        'sum by (status)': [sample({ status: '200' }, 1000)],
      }),
    });

    const record = await runOpsReview(deps, NOW);

    expect(
      record.findings.filter((f) => f.id.startsWith('error-surge:')),
    ).toHaveLength(8);
    expect(record.notes.join()).toContain('他に 4 件あり');
  });

  it('家のログ（Docker・journal）も、home/ を前置きした送信元として数える', async () => {
    const selectors: string[] = [];
    const logs = createLogs(
      {
        'sum by (namespace)': [sample({ namespace: 'app' }, 100)],
        'sum by (container_name)': [
          sample({ container_name: 'daytrade' }, 2000),
        ],
        'sum by (unit)': [
          sample({ unit: 'ssh.service' }, 150),
          sample({}, 5_000_000),
        ],
        'sum by (ip)': [sample({ ip: '192.0.2.1' }, 300)],
        'sum by (status)': [sample({ status: '200' }, 1000)],
      },
      [{ labels: { container_name: 'daytrade' }, line: 'level=error msg=x' }],
    );
    const { deps } = createDeps({
      store: createFakeStore(fiveQuietDays()),
      logs: {
        ...logs,
        lines: async (query) => {
          selectors.push(query.logql);
          return logs.lines(query);
        },
      },
    });

    const record = await runOpsReview(deps, NOW);

    expect(record.snapshot?.errorCounts).toMatchObject({
      app: 100,
      'home/daytrade': 2000,
      'home/ssh.service': 150,
      'home/kernel': 5_000_000,
    });
    expect(record.findings.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        'error-surge:home/daytrade',
        'error-surge:home/ssh.service',
        'error-surge:home/kernel',
      ]),
    );
    // 代表行は、種類に合った家のセレクタで引く。
    expect(
      selectors.some((q) =>
        q.startsWith('{site="home", job="docker", container_name="daytrade"}'),
      ),
    ).toBe(true);
    expect(
      selectors.some((q) =>
        q.startsWith('{site="home", job="journal", unit="ssh.service", '),
      ),
    ).toBe(true);
    expect(
      selectors.some((q) =>
        q.startsWith('{site="home", job="journal", unit="", '),
      ),
    ).toBe(true);
    // journal は本文を正規表現で読まない（洪水の翌日に時間切れで落ちる）。
    expect(
      selectors
        .filter((q) => q.includes('job="journal"'))
        .every((q) => !q.includes('|~')),
    ).toBe(true);
  });

  it('journal の集計は優先度のラベルで絞り、2 時間ごとの 12 本に分けて足し合わせる', async () => {
    const queries: string[] = [];
    const logs = createLogs();
    const { deps } = createDeps({
      logs: {
        ...logs,
        metric: async (query) => {
          queries.push(query.logql);
          if (
            query.logql.includes('job="journal"') &&
            query.logql.includes('offset')
          ) {
            return [sample({ unit: 'ssh.service' }, 10), sample({}, 100)];
          }
          return logs.metric(query);
        },
      },
    });

    const record = await runOpsReview(deps, NOW);

    // クラスタ全体・家のコンテナも同じく 12 本に分ける。
    expect(
      queries.filter((q) => q.includes('sum by (namespace)')),
    ).toHaveLength(12);
    expect(
      queries.filter((q) => q.includes('sum by (container_name)')),
    ).toHaveLength(12);
    const journal = queries.filter((q) => q.includes('job="journal"'));
    expect(journal).toHaveLength(12);
    expect(journal.every((q) => q.includes('priority=~'))).toBe(true);
    expect(journal.every((q) => q.includes('[2h] offset'))).toBe(true);
    expect(journal.some((q) => q.includes('offset 22h'))).toBe(true);
    // 本文の「エラー」を探す正規表現は使わない（洪水の日に遅くなる）。
    expect(journal.every((q) => !q.includes('(?i)'))).toBe(true);
    expect(record.snapshot?.errorCounts).toMatchObject({
      'home/ssh.service': 120,
      'home/kernel': 1200,
    });
  });

  it('journal の区間が 1 本でも取れなければ、その確認の失敗を挙げて基準に残さない', async () => {
    const logs = createLogs();
    let calls = 0;
    const { deps } = createDeps({
      logs: {
        ...logs,
        metric: async (query) => {
          if (query.logql.includes('job="journal"') && ++calls === 5) {
            throw new Error('ログの集計に失敗しました: 500');
          }
          return logs.metric(query);
        },
      },
    });

    const record = await runOpsReview(deps, NOW);

    expect(record.snapshot).toBeUndefined();
    expect(record.findings.map((f) => f.id)).toContain(
      'check-failed:log-home-units',
    );
  });

  it('代表行は、エラーがいちばん多かった区間から取る', async () => {
    const lineRanges: Array<{ start: Date; end: Date }> = [];
    const logs = createLogs({
      'sum by (ip)': [sample({ ip: '192.0.2.1' }, 300)],
      'sum by (status)': [sample({ status: '200' }, 1000)],
    });
    const { deps } = createDeps({
      store: createFakeStore(fiveQuietDays()),
      logs: {
        metric: async (query) => {
          // 4 区間前（8〜6 時間前）だけが多かった。
          const peak = query.logql.includes('offset 6h');
          if (query.logql.startsWith('sum by (namespace)')) {
            return [sample({ namespace: 'app' }, peak ? 1500 : 5)];
          }
          if (query.logql.startsWith('sum(count_over_time(')) {
            return [sample({}, peak ? 900 : 5)];
          }
          return logs.metric(query);
        },
        lines: async (query) => {
          lineRanges.push({ start: query.start, end: query.end });
          return [
            {
              timestamp: '1',
              labels: {},
              line: 'connect() failed to 10.0.0.1:80',
            },
          ];
        },
      },
    });

    const record = await runOpsReview(deps, NOW);

    const surge = record.findings.find((f) => f.id === 'error-surge:app');
    expect(lineRanges[0]?.end.toISOString()).toBe('2026-10-11T18:00:00.000Z');
    expect(lineRanges[0]?.start.toISOString()).toBe('2026-10-11T16:00:00.000Z');
    expect(surge?.evidence?.at(-1)).toContain('10-12 01:00〜03:00（JST）');
  });

  it('継続行（スタックトレースやレジスタダンプ）を除き、見出しの行は数える', () => {
    const continuation = new RegExp(CONTINUATION_LINE);
    for (const line of [
      '   at System.Net.Sockets.Socket.Send()',
      '[RUNNER 2026-10-17 00:32:41Z ERR  BrokerServer]    at System.Threading.Tasks',
      '2026-10-16T10:08:07.206Z stderr F   File "/app/main.py", line 3',
      ' ? srso_return_thunk+0x5/0x5f',
      'RIP: 0010:sysfs_emit_at+0x61/0xd0',
      'R10: 0000000000000000 R11: 0000000000000000',
      'Call Trace:',
      ' <IRQ>',
      '------------[ cut here ]------------',
      '---[ end trace 0000000000000000 ]---',
      'Modules linked in: smsdvb dvb_core',
      'Hardware name: Gigabyte Technology Co., Ltd. B450',
      '--- End of inner exception stack trace ---',
      '[RUNNER 2026-10-17 00:32:41Z ERR  BrokerServer] --- End of inner exception stack trace ---',
      '2026-10-17T00:32:41Z stdout F [RUNNER 2026-10-17 00:32:41Z ERR  BrokerServer] ---> System.Net.Sockets.SocketException (125): Operation canceled',
      '[RUNNER 2026-10-17 00:32:41Z ERR  BrokerServer] #####################################################',
    ]) {
      expect(continuation.test(line), line).toBe(true);
    }
    for (const line of [
      'WARNING: fs/sysfs/file.c:781 at sysfs_emit_at+0x59/0xd0',
      'invalid sysfs_emit_at: buf:00000000601d32f6 at:0',
      '[RUNNER 2026-10-17 00:32:41Z ERR  BrokerServer] System.Net.Http.HttpRequestException: connection reset',
      'Traceback (most recent call last):',
      'level=error msg="failed to connect"',
      '2026-10-16T10:08:07.206Z stderr F Error doing the fallback: x',
      'CPUs online: 8',
    ]) {
      expect(continuation.test(line), line).toBe(false);
    }
  });

  describe('前回報告した急増の続きの扱い', () => {
    const reportedSurge = {
      id: 'error-surge:app',
      severity: 'warning' as const,
      title: 'app のエラー行が平常の 15.0 倍',
      detail: '24 時間のエラー行 1500 件',
    };
    const historyWithReport = () => [
      { ...priorReview(1, QUIET), findings: [reportedSurge] },
      ...[2, 3, 4, 5].map((day) => priorReview(day, QUIET)),
    ];

    /** 区間（offset）ごとに namespace のエラー件数を答える代役。 */
    function logsBySlice(countAt: (offsetHours: number) => number): LogSource {
      const base = createLogs({
        'sum by (ip)': [sample({ ip: '192.0.2.1' }, 300)],
        'sum by (status)': [sample({ status: '200' }, 1000)],
      });
      return {
        ...base,
        metric: async (query) => {
          if (query.logql.includes('sum by (namespace)')) {
            const offset = Number(/offset (\d+)h/.exec(query.logql)?.[1]);
            const count = countAt(offset);
            return count > 0 ? [sample({ namespace: 'app' }, count)] : [];
          }
          return base.metric(query);
        },
      };
    }

    it('報告済みで、いまは収まっていれば外す（24 時間の窓に尻尾が残っていても）', async () => {
      const { deps, log } = createDeps({
        store: createFakeStore(historyWithReport()),
        logs: logsBySlice((offset) => (offset >= 12 ? 300 : 0)),
      });

      const record = await runOpsReview(deps, NOW);

      expect(record.snapshot?.errorCounts.app).toBe(1800);
      expect(record.findings.map((f) => f.id)).not.toContain('error-surge:app');
      expect(log.info).toHaveBeenCalledWith(
        { sources: ['error-surge:app'] },
        expect.stringContaining('calmed down'),
      );
    });

    it('報告済みで、いまも続いていれば、続いていると添えて出す', async () => {
      const { deps } = createDeps({
        store: createFakeStore(historyWithReport()),
        logs: logsBySlice((offset) => (offset <= 4 ? 200 : 0)),
      });

      const record = await runOpsReview(deps, NOW);

      const surge = record.findings.find((f) => f.id === 'error-surge:app');
      expect(surge?.detail).toContain('いまも続いている');
    });

    it('前回報告していなければ、収まっていても出す（まだ知らせていない）', async () => {
      const { deps } = createDeps({
        store: createFakeStore(fiveQuietDays()),
        logs: logsBySlice((offset) => (offset >= 12 ? 300 : 0)),
      });

      const record = await runOpsReview(deps, NOW);

      expect(record.findings.map((f) => f.id)).toContain('error-surge:app');
    });

    it('前回の見回りが失敗していたなら報告済みとは数えない', async () => {
      const failed: OpsReviewRecord = {
        id: 'f',
        reviewedAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
        status: 'failed',
        severity: 'critical',
        findings: [reportedSurge],
        error: 'x',
        notes: [],
      };
      const { deps } = createDeps({
        store: createFakeStore([
          failed,
          ...[2, 3, 4, 5].map((day) => priorReview(day, QUIET)),
        ]),
        logs: logsBySlice((offset) => (offset >= 12 ? 300 : 0)),
      });

      const record = await runOpsReview(deps, NOW);

      expect(record.findings.map((f) => f.id)).toContain('error-surge:app');
    });
  });

  it('初めて見るアクセス元を挙げる', async () => {
    const { deps } = createDeps({
      store: createFakeStore(fiveQuietDays()),
      logs: createLogs({
        'sum by (namespace)': [sample({ namespace: 'app' }, 100)],
        'sum by (ip)': [
          sample({ ip: '192.0.2.1' }, 300),
          sample({ ip: '203.0.113.9' }, 900),
        ],
        'sum by (status)': [sample({ status: '200' }, 1200)],
      }),
    });

    const record = await runOpsReview(deps, NOW);

    expect(record.findings.map((f) => f.id)).toContain(
      'new-source:203.0.113.9',
    );
  });

  it('履歴が足りない間は傾向を判定せず、学習中だと注記する', async () => {
    const { deps } = createDeps({
      store: createFakeStore([priorReview(1, QUIET)]),
      logs: createLogs({
        'sum by (namespace)': [sample({ namespace: 'app' }, 99999)],
        'sum by (ip)': [sample({ ip: '203.0.113.9' }, 99999)],
        'sum by (status)': [sample({ status: '200' }, 1000)],
      }),
    });

    const record = await runOpsReview(deps, NOW);

    expect(record.findings).toEqual([]);
    expect(record.notes.join()).toContain('学習中（1/3 日');
    expect(record.snapshot).toBeDefined();
  });

  it('問い合わせが落ちたら、落ちたこと自体を項目にする（異常なしにしない）', async () => {
    const { deps } = createDeps({
      metrics: createMetrics({ 'up == 0': new Error('connection refused') }),
    });

    const record = await runOpsReview(deps, NOW);

    expect(record.severity).toBe('warning');
    expect(record.findings[0]).toMatchObject({
      id: 'check-failed:targets-down',
    });
    expect(record.findings[0]?.detail).toContain('connection refused');
  });

  it('ログの集計が 1 つでも欠けたら、今日の分を平常の基準に残さない', async () => {
    const { deps } = createDeps({
      logs: createLogs({ 'sum by (ip)': new Error('timeout') }),
    });

    const record = await runOpsReview(deps, NOW);

    expect(record.snapshot).toBeUndefined();
    expect(record.findings.map((f) => f.id)).toContain(
      'check-failed:log-clients',
    );
    expect(record.notes.join()).toContain('平常の基準に残さない');
  });

  it('言葉にできなかったときは本文なしで返す（事実の一覧に縮退して WARN）', async () => {
    const { deps, log } = createDeps({
      metrics: createMetrics({
        probe_success: [sample({ instance: 'https://x.example' }, 0)],
      }),
      narrator: {
        narrate: async () => {
          throw new Error('llm down');
        },
      },
    });

    const record = await runOpsReview(deps, NOW);

    expect(record.narration).toBeUndefined();
    expect(record.findings).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(composeReviewMessage(record)).toContain('死活監視に失敗している');
  });
});

describe('runDueOpsReview', () => {
  let deps: OpsReviewDependencies;
  let sent: Array<{ channelId: string; text: string }>;
  let store: ReturnType<typeof createFakeStore>;

  beforeEach(() => {
    store = createFakeStore();
    ({ deps, sent } = createDeps({
      store,
      metrics: createMetrics({
        probe_success: [sample({ instance: 'https://x.example' }, 0)],
      }),
    }));
  });

  it('時刻前は走らない', async () => {
    expect(await runDueOpsReview(deps, new Date('2026-10-11T22:00:00Z'))).toBe(
      false,
    );
    expect(store.records).toHaveLength(0);
  });

  it('時刻を過ぎていれば走り、結果を残して monitoring へ送る', async () => {
    expect(await runDueOpsReview(deps, NOW)).toBe(true);

    expect(store.records).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channelId).toBe('c-mon');
    expect(sent[0]?.text).toContain('日次レビュー 2026-10-12');
  });

  it('同じ日に二度は走らない', async () => {
    await runDueOpsReview(deps, NOW);
    expect(
      await runDueOpsReview(deps, new Date(NOW.getTime() + 3_600_000)),
    ).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('異常がなければ送らない（記録だけ残す）', async () => {
    const quiet = createDeps({ store: createFakeStore() });
    await runDueOpsReview(quiet.deps, NOW);
    expect(quiet.sent).toEqual([]);
    expect(quiet.deps.store.latest()?.severity).toBe('ok');
  });

  it('postWhenHealthy なら異常なしの日も送る', async () => {
    const healthy = createDeps(
      { store: createFakeStore() },
      baseSettings({ opsReview: { postWhenHealthy: true } }),
    );
    await runDueOpsReview(healthy.deps, NOW);
    expect(healthy.sent[0]?.text).toContain('異常なし');
  });

  it('見回りが落ちたら「落ちた」記録を今日の分として残し、失敗を送る', async () => {
    const failing = createDeps({
      store: createFakeStore(),
      narrator: { narrate: async () => 'x' },
      logs: {
        metric: async () => {
          throw new Error('x');
        },
        lines: async () => [],
      },
    });
    // 集計の失敗は項目になるだけ。見回り自体を落とすのは想定外の例外。
    vi.spyOn(failing.deps.store, 'recentSnapshots').mockImplementation(() => {
      throw new Error('db is locked');
    });

    await runDueOpsReview(failing.deps, NOW);

    expect(failing.deps.store.latest()).toMatchObject({
      status: 'failed',
      error: 'db is locked',
    });
    expect(failing.sent[0]?.text).toContain('見回り自体が失敗しました');
    expect(failing.deps.log.error).toHaveBeenCalled();
    // 失敗も今日の分なので、次の確認でまた走って通知が連打されない。
    expect(
      await runDueOpsReview(failing.deps, new Date(NOW.getTime() + 300_000)),
    ).toBe(false);
  });

  it('宛先の名前が notification.channels に無ければ送らず WARN（記録は残る）', async () => {
    const noChannel = createDeps(
      {
        store: createFakeStore(),
        metrics: createMetrics({
          probe_success: [sample({ instance: 'https://x.example' }, 0)],
        }),
      },
      baseSettings({
        notification: { whenNoOutput: 'drop', channels: {} },
      }),
    );
    await runDueOpsReview(noChannel.deps, NOW);
    expect(noChannel.sent).toEqual([]);
    expect(noChannel.log.warn).toHaveBeenCalled();
    expect(noChannel.deps.store.latest()).toBeDefined();
  });

  it('Discord へ送れなくても例外にせず、ERROR を出す', async () => {
    const broken = createDeps({
      store: createFakeStore(),
      metrics: createMetrics({
        probe_success: [sample({ instance: 'https://x.example' }, 0)],
      }),
      text: {
        send: async () => {
          throw new Error('missing access');
        },
      },
    });
    await expect(runDueOpsReview(broken.deps, NOW)).resolves.toBe(true);
    expect(broken.log.error).toHaveBeenCalled();
  });
});

describe('composeReviewMessage', () => {
  it('本文の秘密は出口で伏せる', () => {
    const message = composeReviewMessage({
      id: '1',
      reviewedAt: NOW.toISOString(),
      status: 'completed',
      severity: 'warning',
      findings: [],
      narration: 'Authorization: Bearer abcdef0123456789xyz が出ていました',
      notes: [],
    });
    expect(message).not.toContain('abcdef0123456789xyz');
  });

  it('Discord の上限（2000 字）に収める', () => {
    const message = composeReviewMessage({
      id: '1',
      reviewedAt: NOW.toISOString(),
      status: 'completed',
      severity: 'notice',
      findings: [],
      narration: 'あ'.repeat(5000),
      notes: [],
    });
    expect(message.length).toBeLessThanOrEqual(2000);
  });
});

describe('queryLogLines', () => {
  it('件数に上限を掛け、返す行の秘密を伏せる', async () => {
    const lines = Array.from({ length: 300 }, () => ({
      labels: { pod: 'p' },
      line: 'token=abcd1234efgh ok',
    }));
    const { deps } = createDeps({ logs: createLogs({}, lines) });

    const result = await queryLogLines(
      deps,
      { logql: '{a="b"}', minutes: 99999, limit: 99999 },
      NOW,
    );

    expect(result).toHaveLength(MAX_QUERY_LINES);
    expect(result[0]?.line).toBe('token=*** ok');
    expect(result[0]?.source).toBe('p');
  });
});

describe('checkClusterHealth', () => {
  it('しきい値型の確認だけを走らせ、重い順に返す', async () => {
    const { deps } = createDeps({
      metrics: createMetrics({
        ALERTS: [sample({ alertname: 'X', severity: 'info' }, 1)],
        node_filesystem_avail_bytes: [
          sample({ instance: 'n1', mountpoint: '/' }, 0.97),
        ],
      }),
    });
    const findings = await checkClusterHealth(deps, NOW);
    expect(findings.map((f) => f.id)).toEqual([
      'metric:node-disk',
      'metric:alerts',
    ]);
  });
});

describe('急増の原因調査（F-54）', () => {
  function surgingLogs() {
    return createLogs(
      {
        'sum by (namespace)': [sample({ namespace: 'app' }, 1500)],
        'sum by (ip)': [sample({ ip: '192.0.2.1' }, 300)],
        'sum by (status)': [sample({ status: '200' }, 1000)],
      },
      [{ labels: { pod: 'p1' }, line: 'connect() failed to 10.0.0.1:80' }],
    );
  }

  it('急増に調書を付け、調書の事実と代表行を渡して見立てを添える。言葉にする側にも渡る', async () => {
    const hypothesize = vi.fn(async () => [
      {
        findingId: 'error-surge:app',
        text: '上流の接続先が落ちているようです。',
        confidence: 'low' as const,
        unverified: '上流の状態',
      },
    ]);
    const narrate = vi.fn(
      async (_material: OpsNarrationMaterial) => '本文です',
    );
    const { deps } = createDeps({
      store: createFakeStore(fiveQuietDays()),
      logs: surgingLogs(),
      hypothesizer: { hypothesize },
      narrator: { narrate },
    });

    const record = await runOpsReview(deps, NOW);

    const surge = record.findings.find((f) => f.id === 'error-surge:app');
    expect(surge?.dossier?.source).toBe('app');
    expect(surge?.dossier?.ongoing).toBe(true);
    expect(surge?.hypothesis).toEqual({
      text: '上流の接続先が落ちているようです。',
      confidence: 'low',
      unverified: '上流の状態',
    });
    expect(hypothesize).toHaveBeenCalledTimes(1);
    const [material] = hypothesize.mock.calls[0] as unknown as [
      {
        items: Array<{
          findingId: string;
          facts: string[];
          evidence: string[];
        }>;
      },
    ];
    expect(material.items[0]?.findingId).toBe('error-surge:app');
    expect(material.items[0]?.facts.length).toBeGreaterThan(0);
    expect(material.items[0]?.evidence[0]).toBe('1× connect() failed to <ip>');
    expect(narrate.mock.calls[0]?.[0].findings[0]?.hypothesis).toBeDefined();
  });

  it('見立てを付けられなくても、調書（事実）と項目は残し、WARN と注記を出す', async () => {
    const { deps, log } = createDeps({
      store: createFakeStore(fiveQuietDays()),
      logs: surgingLogs(),
      hypothesizer: {
        hypothesize: async () => {
          throw new Error('応答が JSON ではありませんでした');
        },
      },
    });

    const record = await runOpsReview(deps, NOW);

    const surge = record.findings.find((f) => f.id === 'error-surge:app');
    expect(surge?.dossier).toBeDefined();
    expect(surge?.hypothesis).toBeUndefined();
    expect(record.notes).toContain(
      '原因の見立ては付けられなかった（数えた事実だけ載せた）',
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('hypothesize'),
    );
  });

  it('急増が無い日は、見立てを呼ばない', async () => {
    const hypothesize = vi.fn(async () => []);
    const { deps } = createDeps({
      store: createFakeStore(fiveQuietDays()),
      hypothesizer: { hypothesize },
    });

    await runOpsReview(deps, NOW);

    expect(hypothesize).not.toHaveBeenCalled();
  });

  it('言葉にできず事実の一覧へ縮退しても、見立ては「推測」と分かる形で、事実とは別の行に出る', async () => {
    const { deps } = createDeps({
      store: createFakeStore(fiveQuietDays()),
      logs: surgingLogs(),
      narrator: {
        narrate: async () => {
          throw new Error('too long');
        },
      },
      hypothesizer: {
        hypothesize: async () => [
          {
            findingId: 'error-surge:app',
            text: '上流が落ちているようです。',
            confidence: 'low' as const,
            unverified: '',
          },
        ],
      },
    });

    const record = await runOpsReview(deps, NOW);
    const text = composeReviewMessage(record);

    expect(text).toContain('いまも続いている');
    expect(text).toContain('（推測・確度は低い）上流が落ちているようです。');
  });
});
