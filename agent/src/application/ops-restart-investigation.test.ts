import { describe, expect, it } from 'vitest';
import type { MetricSample, OpsFinding } from '../domain/ops.ts';
import { renderRestartFacts } from '../domain/ops-restart-investigation.ts';
import type { LogSource } from '../domain/ports/log-source.ts';
import type { MetricSource } from '../domain/ports/metric-source.ts';
import {
  investigateRestarts,
  MAX_INVESTIGATED_CLUSTERS,
  RESTART_FINDING_ID,
} from './ops-restart-investigation.ts';

const NOW = new Date('2026-10-17T13:07:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
/** 実際にあった形: コントロールプレーンの各コンテナが 09:43 に続けて落ちた。 */
const CRASH = Date.parse('2026-10-17T09:43:40.000Z');

const finding = (): OpsFinding => ({
  id: RESTART_FINDING_ID,
  severity: 'warning',
  title: '24 時間以内に再起動したコンテナ（6 件）',
  detail: '…',
});

interface Terminated {
  namespace: string;
  pod: string;
  at: number;
  reason?: string;
}

function terminatedSamples(items: Terminated[]): MetricSample[] {
  return items.map((t) => ({
    labels: { namespace: t.namespace, pod: t.pod, container: t.pod },
    value: t.at / 1000,
  }));
}

function reasonSamples(items: Terminated[]): MetricSample[] {
  return items
    .filter((t) => t.reason)
    .map((t) => ({
      labels: {
        namespace: t.namespace,
        pod: t.pod,
        container: t.pod,
        reason: t.reason ?? '',
      },
      value: 1,
    }));
}

const CONTROL_PLANE: Terminated[] = [
  {
    namespace: 'kube-system',
    pod: 'kube-scheduler',
    at: CRASH,
    reason: 'Error',
  },
  {
    namespace: 'kube-system',
    pod: 'kube-controller-manager',
    at: CRASH - 5_000,
    reason: 'Error',
  },
  {
    namespace: 'harvester-system',
    pod: 'cdi-operator',
    at: CRASH + 15_000,
    reason: 'Completed',
  },
  {
    namespace: 'cattle-capi-system',
    pod: 'capi-controller-manager',
    at: CRASH + 20_000,
    reason: 'Error',
  },
];
const LONE_OOM: Terminated = {
  namespace: 'apps',
  pod: 'worker',
  at: Date.parse('2026-10-17T02:00:00.000Z'),
  reason: 'OOMKilled',
};

function setup(
  items: Terminated[],
  overrides: {
    metrics?: Partial<MetricSource>;
    logs?: Partial<LogSource>;
    rollouts?: MetricSample[];
  } = {},
) {
  const metricQueries: string[] = [];
  const logQueries: { logql: string; at: Date }[] = [];
  const metrics: MetricSource = {
    instant: async ({ promql }) => {
      metricQueries.push(promql);
      if (promql.includes('last_terminated_timestamp'))
        return terminatedSamples(items);
      if (promql.includes('last_terminated_reason'))
        return reasonSamples(items);
      if (promql.includes('kube_replicaset_created'))
        return overrides.rollouts ?? [];
      return [];
    },
    ...overrides.metrics,
  };
  const logs: LogSource = {
    lines: async () => [],
    metric: async ({ logql, at }) => {
      logQueries.push({ logql, at });
      const dayBefore = at.getTime() < NOW.getTime() - DAY / 2 - 4 * 3_600_000;
      return [
        { labels: {}, value: at.getTime() < CRASH - 3_600_000 ? 0 : 1485 },
      ].map((s) => (dayBefore ? { ...s, value: 0 } : s)) as MetricSample[];
    },
    ...overrides.logs,
  };
  return { deps: { metrics, logs }, metricQueries, logQueries };
}

describe('investigateRestarts', () => {
  it('ほぼ同時に落ちたものをまとめ、etcd の遅れを前日と並べて付ける', async () => {
    const { deps, logQueries } = setup([...CONTROL_PLANE, LONE_OOM]);
    const target = finding();

    await investigateRestarts(deps, [target], NOW);

    const dossier = target.restartDossier;
    expect(dossier?.clusters).toHaveLength(1);
    expect(dossier?.clusters[0]).toMatchObject({
      containers: 4,
      namespaces: ['cattle-capi-system', 'harvester-system', 'kube-system'],
      reasons: { Error: 3, Completed: 1 },
      rollouts: [],
      etcdSlow: { during: 1485, dayBefore: 0 },
    });
    expect(dossier?.scattered).toEqual({
      containers: 1,
      reasons: { OOMKilled: 1 },
    });
    expect(dossier?.gaps).toEqual([]);

    // 窓は まとまりの 15 分前〜5 分後。(09:43:35〜09:44:00) + 20 分 → 切り上げて 21 分
    expect(logQueries[0]?.logql).toBe(
      'sum(count_over_time({namespace="kube-system",container="etcd"} |= "took too long" [21m]))',
    );
    expect(logQueries[0]?.at.toISOString()).toBe('2026-10-17T09:49:00.000Z');
    expect(logQueries[1]?.at.toISOString()).toBe('2026-10-16T09:49:00.000Z');
  });

  it('前後 10 分に同じ namespace で作られた ReplicaSet だけを挙げる', async () => {
    const created = (namespace: string, name: string, at: number) => ({
      labels: { namespace, replicaset: name },
      value: at / 1000,
    });
    const { deps } = setup(CONTROL_PLANE, {
      rollouts: [
        created('kube-system', 'coredns-new', CRASH - 4 * 60_000),
        created('kube-system', 'coredns-old', CRASH - 3 * 3_600_000),
        created('monitoring', 'other-ns', CRASH),
      ],
    });
    const target = finding();

    await investigateRestarts(deps, [target], NOW);

    expect(target.restartDossier?.clusters[0]?.rollouts).toEqual([
      'kube-system/coredns-new',
    ]);
  });

  it('調書を事実の行にできる（実際の見回りの形）', async () => {
    const { deps } = setup(CONTROL_PLANE);
    const target = finding();
    await investigateRestarts(deps, [target], NOW);

    if (!target.restartDossier) throw new Error('調書が付いていない');
    expect(renderRestartFacts(target.restartDossier).slice(0, 3)).toEqual([
      '10-17 18:43（JST）ごろ、4 個のコンテナがほぼ同時に落ちた（cattle-capi-system、harvester-system、kube-system。終了の理由: Error ×3、Completed ×1）',
      'そのころ（前後 10 分）に同じ namespace で作られた ReplicaSet は無かった',
      'そのころ（前後 20 分）の etcd の遅い応答の記録: 1485 件（前日の同じ時間帯は 0 件）',
    ]);
  });

  it('再起動の項目が無ければ何も問い合わせない', async () => {
    const { deps, metricQueries, logQueries } = setup(CONTROL_PLANE);

    await investigateRestarts(deps, [], NOW);

    expect(metricQueries).toEqual([]);
    expect(logQueries).toEqual([]);
  });

  it('同時に落ちたものが無ければ、ロールアウトも etcd も調べない', async () => {
    const { deps, metricQueries, logQueries } = setup([LONE_OOM]);
    const target = finding();

    await investigateRestarts(deps, [target], NOW);

    expect(target.restartDossier?.clusters).toEqual([]);
    expect(target.restartDossier?.scattered.containers).toBe(1);
    expect(metricQueries.some((q) => q.includes('kube_replicaset'))).toBe(
      false,
    );
    expect(logQueries).toEqual([]);
  });

  it('etcd を数えられなくても、取れた分は返して gaps に書く（INV-7）', async () => {
    const { deps } = setup(CONTROL_PLANE, {
      logs: {
        metric: async () => {
          throw new Error('Loki が時間切れ');
        },
      },
    });
    const target = finding();

    await investigateRestarts(deps, [target], NOW);

    expect(target.restartDossier?.clusters[0]?.containers).toBe(4);
    expect(target.restartDossier?.clusters[0]?.etcdSlow).toBeUndefined();
    expect(target.restartDossier?.gaps[0]).toContain('Loki が時間切れ');
  });

  it('終了の理由が取れなくても時刻は残し、理由は「理由不明」にする', async () => {
    const base = setup(CONTROL_PLANE);
    const { deps } = setup(CONTROL_PLANE, {
      metrics: {
        instant: async (query) => {
          if (query.promql.includes('last_terminated_reason'))
            throw new Error('取れない');
          return base.deps.metrics.instant(query);
        },
      },
    });
    const target = finding();

    await investigateRestarts(deps, [target], NOW);

    expect(target.restartDossier?.clusters[0]?.reasons).toEqual({
      理由不明: 4,
    });
    expect(target.restartDossier?.gaps[0]).toContain('終了の理由');
  });

  it('再起動の一覧が取れなければ投げる（呼び出し側が WARN と注記にする）', async () => {
    const { deps } = setup(CONTROL_PLANE, {
      metrics: {
        instant: async () => {
          throw new Error('Prometheus に届かない');
        },
      },
    });
    const target = finding();

    await expect(investigateRestarts(deps, [target], NOW)).rejects.toThrow(
      'Prometheus に届かない',
    );
    expect(target.restartDossier).toBeUndefined();
  });

  it('まとまりが多いときは大きい順に 3 つへ絞り（並びは新しい順）、載せなかった数を言う', async () => {
    const group = (hour: number, size: number): Terminated[] =>
      Array.from({ length: size }, (_, i) => ({
        namespace: `ns${hour}`,
        pod: `p${hour}-${i}`,
        at: Date.parse(`2026-10-17T0${hour}:00:00.000Z`) + i * 1_000,
        reason: 'Error',
      }));
    const { deps } = setup([
      ...group(1, 3),
      ...group(2, 6),
      ...group(3, 4),
      ...group(4, 5),
      ...group(5, 3),
    ]);
    const target = finding();

    await investigateRestarts(deps, [target], NOW);

    expect(MAX_INVESTIGATED_CLUSTERS).toBe(3);
    expect(target.restartDossier?.clusters.map((c) => c.containers)).toEqual([
      5, 4, 6,
    ]);
    expect(target.restartDossier?.omittedClusters).toBe(2);
  });
});
