import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetricSample, OpsSnapshot } from '../domain/ops.ts';
import type { LogSource } from '../domain/ports/log-source.ts';
import type { MetricSource } from '../domain/ports/metric-source.ts';
import type {
  OpsReviewRecord,
  OpsReviewStore,
} from '../domain/ports/ops-review-store.ts';
import type { Settings } from '../domain/settings.ts';
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

  it('journal の集計は優先度のラベルで絞り、本文の正規表現を使わない', async () => {
    const queries: string[] = [];
    const logs = createLogs();
    const { deps } = createDeps({
      logs: {
        ...logs,
        metric: async (query) => {
          queries.push(query.logql);
          return logs.metric(query);
        },
      },
    });

    await runOpsReview(deps, NOW);

    const journal = queries.filter((q) => q.includes('job="journal"'));
    expect(journal).toHaveLength(1);
    expect(journal[0]).toContain('priority=~');
    expect(journal[0]).not.toContain('|~');
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
