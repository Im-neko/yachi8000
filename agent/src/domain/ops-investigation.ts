/**
 * 急増の原因調査（F-54, D-51）で扱う値と、その判定。
 *
 * 調書（dossier）は**決定的なコードが数えた事実**。見立て（hypothesis）は LLM が
 * 調書を読んで添える推測で、事実と同じ見え方で混ぜない。
 */

import { formatJstMoment, formatJstWindow } from './jst.ts';

export interface TimelineSlice {
  /** 区間の始まり・終わり（ISO 8601）。 */
  start: string;
  end: string;
  /** その区間のエラー行数。 */
  count: number;
}

export interface DominantPattern {
  /** 正規化したログ行の型。 */
  pattern: string;
  /** ピーク区間のエラー行のうち、この型の識別語を含む行の割合（0〜1）。 */
  share: number;
}

export interface OpsDossier {
  source: string;
  /** 古い順。見回りで集計済みの 24 時間に、始まりが見つからない間だけ過去へ延ばした分を足したもの。 */
  timeline: TimelineSlice[];
  /** この区間の件数がこれを超えたら「平常から外れている」とみなす。 */
  threshold: number;
  /** 平常から外れた最初の時刻。`startedBeforeTimeline` のときは、調べた範囲の先頭。 */
  onset?: string;
  /** 調べた範囲より前から続いている。 */
  startedBeforeTimeline: boolean;
  /** 平常から外れた最後の区間の終わり。いまも続いているなら無い。 */
  end?: string;
  ongoing: boolean;
  peak?: TimelineSlice;
  dominant?: DominantPattern;
  /** 始まりの前後に出て、その前の 24 時間には無かった行の型。 */
  precursors: string[];
  /** 同じ時間帯のほかの変化（発火したアラート・再起動）。 */
  concurrent: string[];
  /** 集められなかったもの。黙って省かず、理由を残す（INV-7）。 */
  gaps: string[];
}

export type HypothesisConfidence = 'low' | 'medium' | 'high';

/** LLM が調書を読んで添えた見立て。**推測**であり、事実ではない。 */
export interface OpsHypothesis {
  text: string;
  confidence: HypothesisConfidence;
  /** 確かめられていないこと。 */
  unverified: string;
}

/** 区間ごとの下限。これ未満の区間は、平常の倍率が高くても「急増」としない。 */
const MIN_SLICE_LINES = 10;
const SURGE_RATIO = 3;

/** 平常から外れた区間の下限。`dailyBaseline` は 24 時間のエラー行数の中央値。 */
export function sliceThreshold(
  dailyBaseline: number,
  slicesPerDay: number,
): number {
  return Math.max(
    MIN_SLICE_LINES,
    (dailyBaseline / slicesPerDay) * SURGE_RATIO,
  );
}

/**
 * `counts`（古い順）のうち、`threshold` を超えた最初と最後の区間。
 * 途中に平常へ戻った区間があっても、最初から最後までを 1 つの出来事として扱う。
 */
export function findSurgeSpan(
  counts: readonly number[],
  threshold: number,
): { first: number; last: number } | undefined {
  const first = counts.findIndex((count) => count > threshold);
  if (first < 0) return undefined;
  let last = first;
  counts.forEach((count, index) => {
    if (count > threshold) last = index;
  });
  return { first, last };
}

/** 割合。`total` が 0 のときは `undefined`（0% と言い切らない）。 */
export function shareOf(part: number, total: number): number | undefined {
  if (total <= 0) return undefined;
  return Math.min(1, part / total);
}

const PLACEHOLDER_WORDS = new Set(['time', 'uuid']);

/**
 * 型（正規化した行）から、行数を数えるための識別語を 1 つ選ぶ。
 * 数字は正規化で潰れているので、英字と `_` だけでできた一番長い語を使う。
 * 短すぎる語は他の行にも出るので、5 文字未満は選ばない。
 */
export function distinctiveToken(pattern: string): string | undefined {
  const words = pattern.match(/[A-Za-z_]{5,}/g) ?? [];
  return words
    .filter((word) => !PLACEHOLDER_WORDS.has(word.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * 調書を、言葉にする前の事実の行にする。LLM に渡す材料であり、
 * 言葉にできなかったときにそのまま出す本文でもある。
 */
export function renderDossierFacts(dossier: OpsDossier): string[] {
  const facts: string[] = [];
  const first = dossier.timeline[0];
  const last = dossier.timeline[dossier.timeline.length - 1];

  if (dossier.onset && first && last) {
    const startedAt = dossier.startedBeforeTimeline
      ? `${formatJstMoment(new Date(first.start))}より前から`
      : `${formatJstMoment(new Date(dossier.onset))}ごろから`;
    const endedAt =
      dossier.ongoing || !dossier.end
        ? 'いまも続いている'
        : `${formatJstMoment(new Date(dossier.end))}ごろまで`;
    facts.push(`${startedAt}、${endedAt}`);
  }
  if (dossier.peak) {
    facts.push(
      `いちばん多かった ${formatJstWindow(new Date(dossier.peak.start), new Date(dossier.peak.end))} は ${dossier.peak.count} 件（急増とみなす目安は 1 区間 ${Math.round(dossier.threshold)} 件超）`,
    );
  }
  if (dossier.dominant) {
    facts.push(
      `その区間のエラー行の ${percent(dossier.dominant.share)} が「${dossier.dominant.pattern}」の型`,
    );
  }
  if (dossier.precursors.length > 0) {
    facts.push(
      `始まりの前後に出て、その前の 24 時間には無かった行: ${dossier.precursors.map((p) => `「${p}」`).join('、')}`,
    );
  }
  if (dossier.concurrent.length > 0) {
    facts.push(`同じ時間帯のほかの変化: ${dossier.concurrent.join('、')}`);
  }
  if (dossier.gaps.length > 0) {
    facts.push(`調べられなかったこと: ${dossier.gaps.join('、')}`);
  }
  return facts;
}

const CONFIDENCE_LABEL: Record<HypothesisConfidence, string> = {
  low: '確度は低い',
  medium: '確度は中程度',
  high: '確度は高め',
};

/** 見立てを、推測だと分かる形の 1 行にする。 */
export function renderHypothesis(hypothesis: OpsHypothesis): string {
  const unverified =
    hypothesis.unverified === ''
      ? ''
      : `（確かめられていないこと: ${hypothesis.unverified}）`;
  return `（推測・${CONFIDENCE_LABEL[hypothesis.confidence]}）${hypothesis.text}${unverified}`;
}
