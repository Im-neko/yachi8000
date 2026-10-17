/**
 * 再起動の原因調査（F-54）で扱う値と、その判定。
 *
 * **コードが数えた事実だけ。** 再起動の「理由の見立て」は付けない。同時に落ちたか、
 * 同じ時間帯にロールアウトがあったか、コントロールプレーンが遅れていたか、を並べて、
 * つなげて読むのは報告を読む人に任せる。
 */

import { formatJstMoment } from './jst.ts';

/** コンテナの直近 1 回の終了。再起動の回数が増えていても、分かるのは最新の 1 回だけ。 */
export interface RestartEvent {
  namespace: string;
  pod: string;
  container: string;
  /** 終了した時刻（ISO 8601）。 */
  at: string;
  /** `Error` `OOMKilled` `Completed` など。取れなければ無い。 */
  reason?: string;
}

/** ほぼ同時に落ちたコンテナのまとまり。 */
export interface RestartCluster {
  /** まとまりの中で最初・最後に終了した時刻（ISO 8601）。 */
  from: string;
  to: string;
  containers: number;
  namespaces: string[];
  /** 終了の理由 → コンテナ数。 */
  reasons: Record<string, number>;
  /** 前後 10 分に、同じ namespace で作られた ReplicaSet（`namespace/name`）。 */
  rollouts: string[];
  /** 前後 20 分の etcd の遅い応答の記録の数と、前日の同じ時間帯の数。 */
  etcdSlow?: { during: number; dayBefore: number };
}

export interface RestartDossier {
  /** 大きい順。 */
  clusters: RestartCluster[];
  /** 調べた数を超えて載せなかったまとまりの数。 */
  omittedClusters: number;
  /** まとまりに入らなかった再起動。 */
  scattered: { containers: number; reasons: Record<string, number> };
  /** 調べられなかったこと（INV-7）。 */
  gaps: string[];
}

/** この間隔以内に続けて落ちたものを、ひとつのまとまりとして数える。 */
export const CLUSTER_GAP_MS = 5 * 60_000;
/** まとまりと呼ぶ最小のコンテナ数。2 つ重なるくらいは偶然でも起きる。 */
export const MIN_CLUSTER_CONTAINERS = 3;

export interface ClusteredRestarts {
  clusters: RestartEvent[][];
  scattered: RestartEvent[];
}

/** 終了時刻が近いものを束ねる。**3 個未満の束は、まとまりと呼ばず散らばりに入れる。** */
export function clusterRestarts(
  events: readonly RestartEvent[],
): ClusteredRestarts {
  const sorted = [...events].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  );
  const groups: RestartEvent[][] = [];
  for (const event of sorted) {
    const group = groups[groups.length - 1];
    const previous = group?.[group.length - 1];
    if (
      group &&
      previous &&
      Date.parse(event.at) - Date.parse(previous.at) <= CLUSTER_GAP_MS
    ) {
      group.push(event);
    } else {
      groups.push([event]);
    }
  }
  return {
    clusters: groups.filter((g) => g.length >= MIN_CLUSTER_CONTAINERS),
    scattered: groups.filter((g) => g.length < MIN_CLUSTER_CONTAINERS).flat(),
  };
}

export function countReasons(
  events: readonly RestartEvent[],
): Record<string, number> {
  const reasons: Record<string, number> = {};
  for (const event of events) {
    const reason = event.reason ?? '理由不明';
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return reasons;
}

function describeReasons(reasons: Readonly<Record<string, number>>): string {
  return Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason} ×${count}`)
    .join('、');
}

export function renderRestartFacts(dossier: RestartDossier): string[] {
  const facts: string[] = [];
  for (const cluster of dossier.clusters) {
    facts.push(
      `${formatJstMoment(new Date(cluster.from))}ごろ、${cluster.containers} 個のコンテナがほぼ同時に落ちた（${cluster.namespaces.join('、')}。終了の理由: ${describeReasons(cluster.reasons)}）`,
    );
    facts.push(
      cluster.rollouts.length > 0
        ? `そのころ（前後 10 分）に同じ namespace で作られた ReplicaSet: ${cluster.rollouts.join('、')}`
        : 'そのころ（前後 10 分）に同じ namespace で作られた ReplicaSet は無かった',
    );
    if (cluster.etcdSlow) {
      facts.push(
        `そのころ（前後 20 分）の etcd の遅い応答の記録: ${cluster.etcdSlow.during} 件（前日の同じ時間帯は ${cluster.etcdSlow.dayBefore} 件）`,
      );
    }
  }
  if (dossier.omittedClusters > 0) {
    facts.push(
      `ほかにも同時に落ちたまとまりが ${dossier.omittedClusters} 件ある（載せたのは大きい順）`,
    );
  }
  if (dossier.scattered.containers > 0) {
    facts.push(
      `ほかの ${dossier.scattered.containers} 個は、ばらばらの時刻に落ちた（終了の理由: ${describeReasons(dossier.scattered.reasons)}）`,
    );
  }
  if (facts.length > 0) {
    facts.push(
      '時刻と理由は、各コンテナの直近 1 回の終了だけ。回数が多いものも、最新の 1 回しか分からない',
    );
  }
  if (dossier.gaps.length > 0) {
    facts.push(`調べられなかったこと: ${dossier.gaps.join('、')}`);
  }
  return facts;
}
