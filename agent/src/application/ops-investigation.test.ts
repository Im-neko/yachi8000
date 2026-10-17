import { describe, expect, it } from 'vitest';
import type { MetricSample, OpsFinding, OpsSnapshot } from '../domain/ops.ts';
import type { LogSource } from '../domain/ports/log-source.ts';
import type { MetricSource } from '../domain/ports/metric-source.ts';
import {
  INVESTIGATION_BUDGET_MS,
  investigateSurges,
} from './ops-investigation.ts';

const NOW = new Date('2026-10-16T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const SOURCE = 'home/kernel';
const FLOOD = 3_000_000;

/** 平常は 1 日 600 件（1 区間 50 件）→ 区間のしきい値は 150 件。 */
const HISTORY: OpsSnapshot[] = [1, 2, 3].map(() => ({
  errorCounts: { [SOURCE]: 600 },
  clientIps: {},
  statusCounts: {},
}));

function surge(source = SOURCE): OpsFinding {
  return {
    id: `error-surge:${source}`,
    severity: 'warning',
    title: `${source} のエラー行が平常の 5000 倍`,
    detail: '24 時間のエラー行 3000000 件',
  };
}

function sample(value: number, labels: Record<string, string> = {}) {
  return [{ labels, value }] as MetricSample[];
}

/**
 * 洪水の 1 日（実際にあった形）。8〜14 時間前の 3 区間が洪水で、始まりは区間の
 * 先頭から 30 分後。直前に `modprobe` の着脱があり、`Started` は平常から出ている行。
 */
function floodDay(overrides: Partial<LogSource> = {}) {
  const queries: string[] = [];
  const logs: LogSource = {
    metric: async ({ logql }) => {
      queries.push(logql);
      const piece = /\[10m\] offset (\d+)m/.exec(logql);
      if (piece) {
        const offset = Number(piece[1]);
        // 区間は 14〜12 時間前。始まりは 30 分後（= 区間の終わりまで 90 分）。
        return sample(offset <= 800 && offset >= 720 ? 1_000 : 0);
      }
      if (logql.includes('|= `smsdvb_do_tune`')) return sample(FLOOD * 0.94);
      if (logql.includes('|= `modprobe`')) return sample(0);
      if (logql.includes('|= `Started`')) return sample(50);
      return sample(5);
    },
    lines: async ({ logql }) => {
      queries.push(logql);
      if (logql.includes('!= `smsdvb_do_tune`')) {
        return [
          {
            timestamp: '1',
            labels: {},
            line: 'sudo: yui : COMMAND=/usr/sbin/modprobe -r smsdvb',
          },
          {
            timestamp: '2',
            labels: {},
            line: 'systemd[1]: Started Session 42 of User yui.',
          },
        ];
      }
      return [
        {
          timestamp: '3',
          labels: {},
          line: 'kernel: WARNING: CPU: 1 at smsdvb_do_tune+0x10',
        },
      ];
    },
    ...overrides,
  };
  return { logs, queries };
}

const NO_METRICS: MetricSource = { instant: async () => [] };

/** 新しい順の 12 区間。インデックス 4〜6（8〜14 時間前）が洪水。 */
const FLOODED_SLICES = [4, 3, 5, 4, 2_000_000, FLOOD, 2_500_000, 5, 4, 3, 6, 5];

describe('investigateSurges', () => {
  it('洪水の日: 始まり・終わり・割合・直前に初めて出た行・同時刻のアラートを事実として集める', async () => {
    const { logs } = floodDay();
    const activeAt = NOW.getTime() - 13 * HOUR + 600_000;
    const finding = surge();
    const notes: string[] = [];

    await investigateSurges(
      {
        logs,
        metrics: {
          instant: async ({ promql }) =>
            promql.startsWith('ALERTS_FOR_STATE')
              ? sample(activeAt / 1000, {
                  alertname: 'NodeNoisy',
                  severity: 'warning',
                })
              : [],
        },
      },
      {
        surges: [finding],
        sliceCounts: { [SOURCE]: FLOODED_SLICES },
        history: HISTORY,
        now: NOW,
      },
      notes,
    );

    const dossier = finding.dossier;
    expect(dossier?.timeline).toHaveLength(12);
    expect(dossier?.startedBeforeTimeline).toBe(false);
    expect(dossier?.ongoing).toBe(false);
    // 区間は 14〜12 時間前、始まりはその 30 分後。
    expect(dossier?.onset).toBe('2026-10-15T10:30:00.000Z');
    expect(dossier?.end).toBe('2026-10-15T16:00:00.000Z');
    expect(dossier?.peak).toMatchObject({
      start: '2026-10-15T12:00:00.000Z',
      end: '2026-10-15T14:00:00.000Z',
      count: FLOOD,
    });
    expect(dossier?.dominant?.share).toBeCloseTo(0.94);
    expect(dossier?.precursors).toEqual([
      'sudo: yui : COMMAND=/usr/sbin/modprobe -r smsdvb',
    ]);
    expect(dossier?.concurrent).toEqual([
      'アラート NodeNoisy が発火（warning）',
    ]);
    expect(dossier?.gaps).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('洪水の元の型は、直前の行を探す問い合わせから除く（上限が洪水の行で埋まらない）', async () => {
    const { logs, queries } = floodDay();
    const finding = surge();

    await investigateSurges(
      { logs, metrics: NO_METRICS },
      {
        surges: [finding],
        sliceCounts: { [SOURCE]: FLOODED_SLICES },
        history: HISTORY,
        now: NOW,
      },
      [],
    );

    expect(
      queries.some(
        (q) =>
          q.includes('{site="home", job="journal"} != `smsdvb_do_tune`') &&
          !q.includes('priority'),
      ),
    ).toBe(true);
  });

  it('いまも続いている急増は、始まりが見つかるまで過去へ延ばして数える', async () => {
    const queries: string[] = [];
    const { logs } = floodDay({
      metric: async ({ logql }) => {
        queries.push(logql);
        const offset = /\] offset (\d+)h/.exec(logql);
        if (offset && logql.startsWith('sum(count_over_time(')) {
          // 24〜28 時間前も洪水、30 時間前は平常。
          return sample(Number(offset[1]) <= 28 ? FLOOD : 5);
        }
        return sample(0);
      },
    });
    const finding = surge();

    await investigateSurges(
      { logs, metrics: NO_METRICS },
      {
        surges: [finding],
        sliceCounts: { [SOURCE]: Array(12).fill(FLOOD) },
        history: HISTORY,
        now: NOW,
      },
      [],
    );

    expect(finding.dossier?.timeline).toHaveLength(16);
    expect(finding.dossier?.ongoing).toBe(true);
    expect(finding.dossier?.end).toBeUndefined();
    expect(queries.some((q) => q.endsWith('[2h] offset 30h))'))).toBe(true);
    expect(queries.some((q) => q.endsWith('[2h] offset 32h))'))).toBe(false);
  });

  it('72 時間さかのぼっても平常に戻らなければ、「それより前から」と書き、直前の行は探さない', async () => {
    const { logs } = floodDay({
      metric: async () => sample(FLOOD),
      lines: async () => [],
    });
    const finding = surge();

    await investigateSurges(
      { logs, metrics: NO_METRICS },
      {
        surges: [finding],
        sliceCounts: { [SOURCE]: Array(12).fill(FLOOD) },
        history: HISTORY,
        now: NOW,
      },
      [],
    );

    expect(finding.dossier?.timeline).toHaveLength(36);
    expect(finding.dossier?.startedBeforeTimeline).toBe(true);
    expect(finding.dossier?.gaps).toContain(
      '始まりが調べた範囲より前のため、始まりの直前の行は探していない',
    );
  });

  it('一部の問い合わせが落ちても、取れた分は返し、取れなかった分は理由つきで残す', async () => {
    const base = floodDay();
    const { logs } = floodDay({
      metric: async (query) => {
        if (query.logql.includes('|= `smsdvb_do_tune`')) {
          throw new Error('Loki 500');
        }
        return base.logs.metric(query);
      },
    });
    const finding = surge();

    await investigateSurges(
      { logs, metrics: NO_METRICS },
      {
        surges: [finding],
        sliceCounts: { [SOURCE]: FLOODED_SLICES },
        history: HISTORY,
        now: NOW,
      },
      [],
    );

    expect(finding.dossier?.onset).toBe('2026-10-15T10:30:00.000Z');
    expect(finding.dossier?.dominant).toBeUndefined();
    expect(finding.dossier?.gaps).toContain('代表パターンの割合（Loki 500）');
  });

  it('急増が特定の区間に集中していなければ、その旨を残す', async () => {
    const { logs } = floodDay();
    const finding = surge();

    await investigateSurges(
      { logs, metrics: NO_METRICS },
      {
        surges: [finding],
        sliceCounts: { [SOURCE]: Array(12).fill(20) },
        history: HISTORY,
        now: NOW,
      },
      [],
    );

    expect(finding.dossier?.gaps).toEqual([
      '急増が特定の区間に集中していなかった',
    ]);
  });

  it('調べるのは重い順の上位 3 件だけ。残りは調べたことにせず、注記に出す', async () => {
    const { logs } = floodDay();
    const surges = ['a', 'b', 'c', 'd'].map((name) => surge(name));
    const notes: string[] = [];

    await investigateSurges(
      { logs, metrics: NO_METRICS },
      {
        surges,
        sliceCounts: Object.fromEntries(
          ['a', 'b', 'c', 'd'].map((name) => [name, FLOODED_SLICES]),
        ),
        history: HISTORY,
        now: NOW,
      },
      notes,
    );

    expect(surges.map((s) => s.dossier !== undefined)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(notes).toEqual(['急増の原因は、重い順に 3 件だけ調べた']);
  });

  it('持ち時間を超えたら、残りは調べず、調べなかったことを残す（INV-7）', async () => {
    const { logs, queries } = floodDay();
    const surges = [surge('a'), surge('b')];
    const notes: string[] = [];
    // 最初の確認だけ時間内、以後は超過。
    let ticks = 0;
    const clock = () => (ticks++ < 2 ? 0 : INVESTIGATION_BUDGET_MS + 1);

    await investigateSurges(
      { logs, metrics: NO_METRICS },
      {
        surges,
        sliceCounts: { a: FLOODED_SLICES, b: FLOODED_SLICES },
        history: HISTORY,
        now: NOW,
        clock,
      },
      notes,
    );

    expect(surges[0]?.dossier?.gaps).toContain(
      '持ち時間を超えたため、残りは調べていない',
    );
    expect(surges[1]?.dossier).toBeUndefined();
    expect(notes).toContain('b の原因は、持ち時間を超えたため調べていない');
    expect(queries.length).toBeLessThan(10);
  });
});
