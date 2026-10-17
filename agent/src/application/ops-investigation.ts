import {
  errorBaseline,
  groupLogPatterns,
  type OpsFinding,
  type OpsSnapshot,
} from '../domain/ops.ts';
import {
  type DominantPattern,
  distinctiveToken,
  findSurgeSpan,
  type OpsDossier,
  shareOf,
  sliceThreshold,
  type TimelineSlice,
} from '../domain/ops-investigation.ts';
import {
  evidenceQueryOf,
  HOME_PREFIX,
  HOUR_MS,
  NOT_CONTINUATION,
  SAFE_SOURCE_NAME,
  SLICE_COUNT,
  SLICE_HOURS,
  sliceRange,
  surroundingQueryOf,
} from './ops-log-queries.ts';
import type { OpsQueryDependencies } from './ops-review.ts';

/** 原因を調べる急増の数。調書は問い合わせが多いので、上位だけに絞る。 */
export const MAX_INVESTIGATED_SURGES = 3;
/** 始まりを探して過去へ延ばす上限（72 時間）。 */
const MAX_TIMELINE_SLICES = 72 / SLICE_HOURS;
/** 始まりの区間の中を、この長さで刻んで始まりを絞る。 */
const ONSET_PIECE_MINUTES = 10;
/** 始まりの前後に出た行を拾う範囲。 */
const PRECURSOR_BEFORE_MINUTES = 30;
const PRECURSOR_AFTER_MINUTES = 10;
const PRECURSOR_LINES = 300;
const PRECURSOR_CANDIDATES = 8;
const MAX_PRECURSORS = 5;
const PRECURSOR_MAX_LENGTH = 160;
const DOMINANT_SAMPLE_LINES = 300;
const MINUTE_MS = 60_000;
/** 調書づくり全体の持ち時間。超えたら残りの項目は調べず、調べなかったことを書く。 */
export const INVESTIGATION_BUDGET_MS = 5 * 60_000;
const MAX_CONCURRENT = 4;

export interface InvestigationInput {
  /** `error-surge:` の項目（重い順）。 */
  surges: readonly OpsFinding[];
  /** 送信元ごとの、直近 24 時間の 2 時間ごとの件数（先頭が最新）。 */
  sliceCounts: Readonly<Record<string, readonly number[]>>;
  history: readonly OpsSnapshot[];
  now: Date;
  /** 持ち時間の計測に使う時計。 */
  clock?: () => number;
}

function sumOf(samples: readonly { value: number }[]): number {
  return samples.reduce((sum, sample) => sum + sample.value, 0);
}

function describeError(error: unknown): string {
  return (error as Error).message;
}

/** 送信元ひとつの調書を作る。**部分的に取れなくても、取れた分は返し、取れなかった分は `gaps` に書く。** */
async function buildDossier(
  deps: OpsQueryDependencies,
  source: string,
  recent: readonly number[],
  history: readonly OpsSnapshot[],
  now: Date,
  outOfTime: () => boolean,
): Promise<OpsDossier> {
  const gaps: string[] = [];
  const threshold = sliceThreshold(errorBaseline(source, history), SLICE_COUNT);
  const dossier: OpsDossier = {
    source,
    timeline: [],
    threshold,
    startedBeforeTimeline: false,
    ongoing: false,
    precursors: [],
    concurrent: [],
    gaps,
  };
  const countQuery = evidenceQueryOf(source);
  const sliceEnd = (index: number) =>
    new Date(now.getTime() - index * SLICE_HOURS * HOUR_MS);

  // 新しい順に並べておき、始まりが見つかるまで過去へ延ばす。
  const counts = [...recent];
  try {
    while (
      (counts[counts.length - 1] ?? 0) > threshold &&
      counts.length < MAX_TIMELINE_SLICES &&
      !outOfTime()
    ) {
      const offset = counts.length * SLICE_HOURS;
      counts.push(
        sumOf(
          await deps.logs.metric({
            logql: `sum(count_over_time(${countQuery} ${sliceRange(offset)}))`,
            at: now,
          }),
        ),
      );
    }
  } catch (error) {
    gaps.push(`過去の区間の件数（${describeError(error)}）`);
  }
  dossier.timeline = counts
    .map(
      (count, index): TimelineSlice => ({
        start: new Date(
          sliceEnd(index).getTime() - SLICE_HOURS * HOUR_MS,
        ).toISOString(),
        end: sliceEnd(index).toISOString(),
        count,
      }),
    )
    .reverse();

  const span = findSurgeSpan(
    dossier.timeline.map((slice) => slice.count),
    threshold,
  );
  if (!span) {
    gaps.push('急増が特定の区間に集中していなかった');
    return dossier;
  }
  const onsetSlice = dossier.timeline[span.first];
  const lastSlice = dossier.timeline[span.last];
  if (!onsetSlice || !lastSlice) return dossier;

  dossier.ongoing = span.last === dossier.timeline.length - 1;
  if (!dossier.ongoing) dossier.end = lastSlice.end;
  dossier.peak = dossier.timeline
    .slice(span.first, span.last + 1)
    .reduce((peak, slice) => (slice.count > peak.count ? slice : peak));

  // 始まり: 最初の区間の中を 10 分ずつに刻む。調べた範囲の先頭から超えていたら、それより前から。
  dossier.onset = onsetSlice.start;
  if (span.first === 0) {
    dossier.startedBeforeTimeline = true;
  } else if (!outOfTime()) {
    try {
      dossier.onset = await refineOnset(
        deps,
        countQuery,
        onsetSlice,
        threshold,
        now,
      );
    } catch (error) {
      gaps.push(`始まりの時刻の絞り込み（${describeError(error)}）`);
    }
  }

  if (!outOfTime()) {
    try {
      dossier.dominant = await findDominant(
        deps,
        countQuery,
        dossier.peak,
        now,
      );
      if (!dossier.dominant) gaps.push('代表パターンの割合');
    } catch (error) {
      gaps.push(`代表パターンの割合（${describeError(error)}）`);
    }
  }

  if (dossier.startedBeforeTimeline) {
    gaps.push('始まりが調べた範囲より前のため、始まりの直前の行は探していない');
  } else if (!outOfTime()) {
    try {
      dossier.precursors = await findPrecursors(
        deps,
        source,
        new Date(dossier.onset),
        dossier.dominant,
        now,
      );
    } catch (error) {
      gaps.push(`始まりの直前に初めて出た行（${describeError(error)}）`);
    }
  }

  if (!outOfTime()) {
    try {
      dossier.concurrent = await findConcurrent(
        deps,
        source,
        dossier,
        onsetSlice,
        now,
      );
    } catch (error) {
      gaps.push(`同じ時間帯のほかの変化（${describeError(error)}）`);
    }
  }
  if (outOfTime()) gaps.push('持ち時間を超えたため、残りは調べていない');
  return dossier;
}

/** 始まりの区間を `ONSET_PIECE_MINUTES` ごとに数えて、最初に超えた刻みの頭を返す。 */
async function refineOnset(
  deps: OpsQueryDependencies,
  countQuery: string,
  slice: TimelineSlice,
  threshold: number,
  now: Date,
): Promise<string> {
  const pieces = (SLICE_HOURS * 60) / ONSET_PIECE_MINUTES;
  const pieceThreshold = threshold / pieces;
  const start = new Date(slice.start).getTime();
  for (let i = 0; i < pieces; i++) {
    const pieceEnd = start + (i + 1) * ONSET_PIECE_MINUTES * MINUTE_MS;
    const offset = Math.round((now.getTime() - pieceEnd) / MINUTE_MS);
    const count = sumOf(
      await deps.logs.metric({
        logql: `sum(count_over_time(${countQuery} [${ONSET_PIECE_MINUTES}m] offset ${offset}m))`,
        at: now,
      }),
    );
    if (count > pieceThreshold) {
      return new Date(
        start + i * ONSET_PIECE_MINUTES * MINUTE_MS,
      ).toISOString();
    }
  }
  return slice.start;
}

/** ピーク区間の代表パターンと、その区間のエラー行に占める割合（標本ではなく数えた件数）。 */
async function findDominant(
  deps: OpsQueryDependencies,
  countQuery: string,
  peak: TimelineSlice,
  now: Date,
): Promise<DominantPattern | undefined> {
  const lines = await deps.logs.lines({
    logql: countQuery,
    start: new Date(peak.start),
    end: new Date(peak.end),
    limit: DOMINANT_SAMPLE_LINES,
  });
  const top = groupLogPatterns(
    lines.map((l) => l.line),
    1,
  )[0];
  const token = top ? distinctiveToken(top.pattern) : undefined;
  if (!top || !token) return undefined;

  const offsetHours = Math.round(
    (now.getTime() - new Date(peak.end).getTime()) / HOUR_MS,
  );
  const matching = sumOf(
    await deps.logs.metric({
      logql: `sum(count_over_time(${countQuery} |= \`${token}\` ${sliceRange(offsetHours)}))`,
      at: now,
    }),
  );
  const share = shareOf(matching, peak.count);
  return share === undefined ? undefined : { pattern: top.pattern, share };
}

/**
 * 始まりの前後に出た行の型のうち、その前の 24 時間に 1 度も出ていないもの。
 * 洪水の元の型は除いて探す（除かないと、上限の件数が洪水の行で埋まる）。
 */
async function findPrecursors(
  deps: OpsQueryDependencies,
  source: string,
  onset: Date,
  dominant: DominantPattern | undefined,
  now: Date,
): Promise<string[]> {
  const surrounding = surroundingQueryOf(source);
  const floodToken = dominant ? distinctiveToken(dominant.pattern) : undefined;
  const exclude = floodToken ? ` != \`${floodToken}\`` : '';
  const lines = await deps.logs.lines({
    logql: `${surrounding}${exclude} ${NOT_CONTINUATION}`,
    start: new Date(onset.getTime() - PRECURSOR_BEFORE_MINUTES * MINUTE_MS),
    end: new Date(onset.getTime() + PRECURSOR_AFTER_MINUTES * MINUTE_MS),
    limit: PRECURSOR_LINES,
  });

  // 「その前の 24 時間」は、拾った範囲の始まりまで。
  const priorEnd = onset.getTime() - PRECURSOR_BEFORE_MINUTES * MINUTE_MS;
  const offset = Math.ceil((now.getTime() - priorEnd) / MINUTE_MS);
  const precursors: string[] = [];
  for (const { pattern } of groupLogPatterns(
    lines.map((l) => l.line),
    PRECURSOR_CANDIDATES,
  )) {
    const token = distinctiveToken(pattern);
    if (!token) continue;
    const before = sumOf(
      await deps.logs.metric({
        logql: `sum(count_over_time(${surrounding} |= \`${token}\` [24h] offset ${offset}m))`,
        at: now,
      }),
    );
    if (before === 0) precursors.push(pattern.slice(0, PRECURSOR_MAX_LENGTH));
    if (precursors.length >= MAX_PRECURSORS) break;
  }
  return precursors;
}

/** 同じ時間帯に動いていたアラートと、（クラスタの送信元なら）再起動したコンテナ。 */
async function findConcurrent(
  deps: OpsQueryDependencies,
  source: string,
  dossier: OpsDossier,
  onsetSlice: TimelineSlice,
  now: Date,
): Promise<string[]> {
  const found = new Set<string>();
  const from = new Date(dossier.onset ?? onsetSlice.start).getTime() - HOUR_MS;
  const to = (dossier.end ? new Date(dossier.end) : now).getTime() + HOUR_MS;

  const alerts = await deps.metrics.instant({
    promql: 'ALERTS_FOR_STATE{alertname!~"Watchdog|InfoInhibitor"}',
    at: now,
  });
  for (const alert of alerts) {
    const activeAt = alert.value * 1000;
    if (activeAt >= from && activeAt <= to) {
      found.add(
        `アラート ${alert.labels.alertname ?? '?'} が発火（${alert.labels.severity ?? '?'}）`,
      );
    }
  }

  if (!source.startsWith(HOME_PREFIX) && SAFE_SOURCE_NAME.test(source)) {
    const offsetHours = Math.round(
      (now.getTime() - new Date(onsetSlice.end).getTime()) / HOUR_MS,
    );
    const restarts = await deps.metrics.instant({
      promql: `increase(kube_pod_container_status_restarts_total{namespace="${source}"}[${SLICE_HOURS}h] offset ${offsetHours}h) > 0.5`,
      at: now,
    });
    for (const sample of restarts) {
      found.add(
        `${sample.labels.pod ?? '?'}:${sample.labels.container ?? '?'} が始まりの区間で ${Math.round(sample.value)} 回再起動`,
      );
    }
  }
  return [...found].slice(0, MAX_CONCURRENT);
}

/**
 * 急増の上位に調書を付ける（F-54）。**調書は数えた事実だけ**で、原因の説明は含まない。
 * 持ち時間を超えたら残りは調べず、調べなかった旨を調書に書く（INV-7）。
 */
export async function investigateSurges(
  deps: OpsQueryDependencies,
  input: InvestigationInput,
  notes: string[],
): Promise<void> {
  const clock = input.clock ?? Date.now;
  const startedAt = clock();
  const outOfTime = () => clock() - startedAt > INVESTIGATION_BUDGET_MS;

  const targets = input.surges.slice(0, MAX_INVESTIGATED_SURGES);
  if (input.surges.length > targets.length) {
    notes.push(
      `急増の原因は、重い順に ${MAX_INVESTIGATED_SURGES} 件だけ調べた`,
    );
  }

  for (const finding of targets) {
    const source = finding.id.slice('error-surge:'.length);
    const recent = input.sliceCounts[source];
    if (!SAFE_SOURCE_NAME.test(source) || !recent) continue;
    if (outOfTime()) {
      notes.push(`${source} の原因は、持ち時間を超えたため調べていない`);
      continue;
    }
    finding.dossier = await buildDossier(
      deps,
      source,
      recent,
      input.history,
      input.now,
      outOfTime,
    );
  }
}
