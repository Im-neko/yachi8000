import type { MetricSample, OpsFinding } from '../domain/ops.ts';
import {
  clusterRestarts,
  countReasons,
  type RestartCluster,
  type RestartDossier,
  type RestartEvent,
} from '../domain/ops-restart-investigation.ts';
import {
  ETCD_SELECTOR,
  ETCD_SLOW_FILTER,
  WINDOW_MS,
} from './ops-log-queries.ts';
import type { OpsQueryDependencies } from './ops-review.ts';

export const RESTART_FINDING_ID = 'metric:restarts';
/** 調べるまとまりの数。大きい順に絞る。 */
export const MAX_INVESTIGATED_CLUSTERS = 3;
const MINUTE_MS = 60_000;
/** まとまりの前後で、ロールアウト（ReplicaSet の作成）を探す幅。 */
const ROLLOUT_MARGIN_MS = 10 * MINUTE_MS;
/** まとまりの前後で、etcd の遅い応答を数える幅（前 15 分・後ろ 5 分）。 */
const ETCD_BEFORE_MS = 15 * MINUTE_MS;
const ETCD_AFTER_MS = 5 * MINUTE_MS;

const RESTARTED_24H =
  'increase(kube_pod_container_status_restarts_total[24h]) > 0.5';

const containerKey = (labels: MetricSample['labels']) =>
  `${labels.namespace}/${labels.pod}/${labels.container}`;

/** 24 時間以内に再起動したコンテナの、直近の終了。理由は取れなくても時刻は残す。 */
async function fetchRestartEvents(
  deps: OpsQueryDependencies,
  now: Date,
  gaps: string[],
): Promise<RestartEvent[]> {
  const terminated = await deps.metrics.instant({
    promql: `kube_pod_container_status_last_terminated_timestamp and on(namespace,pod,container) (${RESTARTED_24H})`,
    at: now,
  });

  const reasons = new Map<string, string>();
  try {
    const samples = await deps.metrics.instant({
      promql: `(kube_pod_container_status_last_terminated_reason == 1) and on(namespace,pod,container) (${RESTARTED_24H})`,
      at: now,
    });
    for (const sample of samples) {
      const reason = sample.labels.reason;
      if (reason) reasons.set(containerKey(sample.labels), reason);
    }
  } catch (error) {
    gaps.push(`終了の理由（${(error as Error).message}）`);
  }

  const earliest = now.getTime() - WINDOW_MS;
  return terminated
    .filter(
      (sample) =>
        sample.labels.namespace &&
        sample.labels.pod &&
        sample.labels.container &&
        sample.value * 1000 >= earliest,
    )
    .map((sample) => ({
      namespace: sample.labels.namespace ?? '?',
      pod: sample.labels.pod ?? '?',
      container: sample.labels.container ?? '?',
      at: new Date(sample.value * 1000).toISOString(),
      reason: reasons.get(containerKey(sample.labels)),
    }));
}

interface Rollout {
  namespace: string;
  name: string;
  at: number;
}

async function fetchRollouts(
  deps: OpsQueryDependencies,
  now: Date,
): Promise<Rollout[]> {
  const since = Math.floor((now.getTime() - WINDOW_MS) / 1000);
  const samples = await deps.metrics.instant({
    promql: `kube_replicaset_created > ${since}`,
    at: now,
  });
  return samples.map((sample) => ({
    namespace: sample.labels.namespace ?? '?',
    name: sample.labels.replicaset ?? '?',
    at: sample.value * 1000,
  }));
}

async function countEtcdSlow(
  deps: OpsQueryDependencies,
  from: number,
  to: number,
  offsetMs: number,
): Promise<number> {
  const end = to + ETCD_AFTER_MS - offsetMs;
  const minutes = Math.max(
    1,
    Math.ceil((to + ETCD_AFTER_MS - (from - ETCD_BEFORE_MS)) / MINUTE_MS),
  );
  const samples = await deps.logs.metric({
    logql: `sum(count_over_time(${ETCD_SELECTOR} ${ETCD_SLOW_FILTER} [${minutes}m]))`,
    at: new Date(end),
  });
  return samples.reduce((sum, sample) => sum + sample.value, 0);
}

async function describeCluster(
  deps: OpsQueryDependencies,
  events: readonly RestartEvent[],
  rollouts: readonly Rollout[] | undefined,
  gaps: string[],
): Promise<RestartCluster> {
  const times = events.map((e) => Date.parse(e.at));
  const from = Math.min(...times);
  const to = Math.max(...times);
  const namespaces = [...new Set(events.map((e) => e.namespace))].sort();

  const cluster: RestartCluster = {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    containers: events.length,
    namespaces,
    reasons: countReasons(events),
    rollouts: [],
  };

  if (rollouts) {
    cluster.rollouts = rollouts
      .filter(
        (r) =>
          namespaces.includes(r.namespace) &&
          r.at >= from - ROLLOUT_MARGIN_MS &&
          r.at <= to + ROLLOUT_MARGIN_MS,
      )
      .map((r) => `${r.namespace}/${r.name}`);
  }

  try {
    const [during, dayBefore] = await Promise.all([
      countEtcdSlow(deps, from, to, 0),
      countEtcdSlow(deps, from, to, WINDOW_MS),
    ]);
    cluster.etcdSlow = { during, dayBefore };
  } catch (error) {
    gaps.push(
      `etcd の遅い応答の数（${new Date(from).toISOString()} ごろ。${(error as Error).message}）`,
    );
  }
  return cluster;
}

/**
 * `metric:restarts` の項目に、再起動の調書を付ける。**数えるだけで、原因は言わない。**
 * 取れなかった部分は `gaps` に書いて、取れた分は返す（INV-7）。
 * 再起動の一覧そのものが取れなければ投げる（呼び出し側が WARN と注記にする）。
 */
export async function investigateRestarts(
  deps: OpsQueryDependencies,
  findings: readonly OpsFinding[],
  now: Date,
): Promise<void> {
  const finding = findings.find((f) => f.id === RESTART_FINDING_ID);
  if (!finding) return;

  const gaps: string[] = [];
  const events = await fetchRestartEvents(deps, now, gaps);
  const { clusters, scattered } = clusterRestarts(events);

  let rollouts: Rollout[] | undefined;
  if (clusters.length > 0) {
    try {
      rollouts = await fetchRollouts(deps, now);
    } catch (error) {
      gaps.push(`ロールアウトの有無（${(error as Error).message}）`);
    }
  }

  const biggest = [...clusters]
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_INVESTIGATED_CLUSTERS);
  const described: RestartCluster[] = [];
  for (const group of biggest) {
    described.push(await describeCluster(deps, group, rollouts, gaps));
  }
  // 新しいものを先に。
  described.sort((a, b) => Date.parse(b.from) - Date.parse(a.from));

  const dossier: RestartDossier = {
    clusters: described,
    omittedClusters: clusters.length - biggest.length,
    scattered: {
      containers: scattered.length,
      reasons: countReasons(scattered),
    },
    gaps,
  };
  finding.restartDossier = dossier;
}
