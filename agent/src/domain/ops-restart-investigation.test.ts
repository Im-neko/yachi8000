import { describe, expect, it } from 'vitest';
import {
  clusterRestarts,
  countReasons,
  type RestartCluster,
  type RestartDossier,
  type RestartEvent,
  renderRestartFacts,
} from './ops-restart-investigation.ts';

function event(
  minute: number,
  pod: string,
  reason: string | null = 'Error',
  namespace = 'kube-system',
): RestartEvent {
  return {
    namespace,
    pod,
    container: pod,
    at: new Date(Date.UTC(2026, 9, 17, 9, minute)).toISOString(),
    reason: reason ?? undefined,
  };
}

describe('clusterRestarts', () => {
  it('5 分以内に続けて落ちた 3 個以上を、ひとつのまとまりにする', () => {
    const { clusters, scattered } = clusterRestarts([
      event(43, 'a'),
      event(44, 'b'),
      event(46, 'c'),
      event(50, 'd'),
    ]);
    expect(clusters.map((c) => c.map((e) => e.pod))).toEqual([
      ['a', 'b', 'c', 'd'],
    ]);
    expect(scattered).toEqual([]);
  });

  it('間が空けば別のまとまり。3 個に満たない束は散らばりに入れる', () => {
    const { clusters, scattered } = clusterRestarts([
      event(0, 'a'),
      event(1, 'b'),
      event(2, 'c'),
      event(30, 'd'),
      event(31, 'e'),
    ]);
    expect(clusters).toHaveLength(1);
    expect(scattered.map((e) => e.pod)).toEqual(['d', 'e']);
  });

  it('並びが前後していても時刻で束ねる', () => {
    const { clusters } = clusterRestarts([
      event(2, 'c'),
      event(0, 'a'),
      event(1, 'b'),
    ]);
    expect(clusters[0]?.map((e) => e.pod)).toEqual(['a', 'b', 'c']);
  });
});

describe('countReasons', () => {
  it('理由ごとに数える。取れなかったものは「理由不明」', () => {
    expect(
      countReasons([event(0, 'a'), event(1, 'b', null), event(2, 'c')]),
    ).toEqual({ Error: 2, 理由不明: 1 });
  });
});

const cluster: RestartCluster = {
  from: '2026-10-17T09:43:43.000Z',
  to: '2026-10-17T09:43:58.000Z',
  containers: 9,
  namespaces: ['harvester-system', 'kube-system'],
  reasons: { Error: 6, Completed: 3 },
  rollouts: [],
  etcdSlow: { during: 1485, dayBefore: 0 },
};

const dossier: RestartDossier = {
  clusters: [cluster],
  omittedClusters: 0,
  scattered: { containers: 2, reasons: { OOMKilled: 2 } },
  gaps: [],
};

describe('renderRestartFacts', () => {
  it('同時に落ちたこと・ロールアウトの有無・etcd の遅れ・ばらばらの分を事実として並べる', () => {
    expect(renderRestartFacts(dossier)).toEqual([
      '10-17 18:43（JST）ごろ、9 個のコンテナがほぼ同時に落ちた（harvester-system、kube-system。終了の理由: Error ×6、Completed ×3）',
      'そのころ（前後 10 分）に同じ namespace で作られた ReplicaSet は無かった',
      'そのころ（前後 20 分）の etcd の遅い応答の記録: 1485 件（前日の同じ時間帯は 0 件）',
      'ほかの 2 個は、ばらばらの時刻に落ちた（終了の理由: OOMKilled ×2）',
      '時刻と理由は、各コンテナの直近 1 回の終了だけ。回数が多いものも、最新の 1 回しか分からない',
    ]);
  });

  it('ロールアウトがあれば名前を挙げる。etcd を数えられなかったときは黙らず gaps に出す', () => {
    const facts = renderRestartFacts({
      ...dossier,
      clusters: [
        {
          ...cluster,
          rollouts: ['kube-system/coredns-abc'],
          etcdSlow: undefined,
        },
      ],
      gaps: ['etcd の遅い応答の数（timeout）'],
    });
    expect(facts[1]).toBe(
      'そのころ（前後 10 分）に同じ namespace で作られた ReplicaSet: kube-system/coredns-abc',
    );
    expect(facts.at(-1)).toBe(
      '調べられなかったこと: etcd の遅い応答の数（timeout）',
    );
    expect(facts.join('\n')).not.toContain('etcd の遅い応答の記録');
  });

  it('載せなかったまとまりの数を言う', () => {
    expect(
      renderRestartFacts({ ...dossier, omittedClusters: 2 }).join('\n'),
    ).toContain('ほかにも同時に落ちたまとまりが 2 件ある');
  });

  it('再起動が見つからなければ何も言わない', () => {
    expect(
      renderRestartFacts({
        clusters: [],
        omittedClusters: 0,
        scattered: { containers: 0, reasons: {} },
        gaps: [],
      }),
    ).toEqual([]);
  });
});
