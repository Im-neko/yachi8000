/**
 * 運用の見回り（F-53）で扱う値と、その判定。
 *
 * 異常かどうかの判断は**ここ（決定的なコード）で下す**。LLM は見つかったものを
 * 言葉にするだけで、重大度も項目の有無も決めない（INV-3）。
 */

import { JST_OFFSET_MS } from './jst.ts';
import type { OpsDossier, OpsHypothesis } from './ops-investigation.ts';
import { renderDossierFacts, renderHypothesis } from './ops-investigation.ts';
import type { RestartDossier } from './ops-restart-investigation.ts';
import { renderRestartFacts } from './ops-restart-investigation.ts';

export type OpsSeverity = 'notice' | 'warning' | 'critical';
export type OpsOverall = OpsSeverity | 'ok';

const SEVERITY_RANK: Record<OpsSeverity, number> = {
  notice: 1,
  warning: 2,
  critical: 3,
};

export interface MetricSample {
  labels: Readonly<Record<string, string>>;
  value: number;
}

export interface OpsFinding {
  /** 同じ事象を指す安定した鍵（`error-surge:<namespace>` など）。 */
  id: string;
  severity: OpsSeverity;
  title: string;
  /** 数字と名前だけで書いた事実。LLM が言い換えても、ここが正。 */
  detail: string;
  /** ログから拾った代表的な行（正規化・マスク済み）。無いこともある。 */
  evidence?: string[];
  /** 急増の原因調査（F-54）で数えた事実。急増の上位だけに付く。 */
  dossier?: OpsDossier;
  /** 再起動の原因調査（F-54）で数えた事実。`metric:restarts` だけに付く。 */
  restartDossier?: RestartDossier;
  /** 調書を読んだ LLM の見立て。**推測**であり、事実とは分けて出す。 */
  hypothesis?: OpsHypothesis;
}

/**
 * 1 回の見回りで数えたもの。**翌日以降の「平常」の基準**になるので、
 * Loki の保持期間に頼らず、こちらの DB に日ごとに残す。
 */
export interface OpsSnapshot {
  /** 送信元の名前（namespace など）→ 24 時間のエラー行数。 */
  errorCounts: Record<string, number>;
  /** クライアント IP → 24 時間のリクエスト数（上位のみ）。 */
  clientIps: Record<string, number>;
  /** `2xx` `3xx` `4xx` `5xx` → リクエスト数。 */
  statusCounts: Record<string, number>;
}

/** 重大度の並びで一番重いもの。並びが空なら最も軽い `notice`。 */
export function maxSeverity(severities: readonly OpsSeverity[]): OpsSeverity {
  let top: OpsSeverity = 'notice';
  for (const severity of severities) {
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[top]) top = severity;
  }
  return top;
}

export function overallSeverity(findings: readonly OpsFinding[]): OpsOverall {
  if (findings.length === 0) return 'ok';
  return maxSeverity(findings.map((f) => f.severity));
}

export function sortBySeverity(findings: readonly OpsFinding[]): OpsFinding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
}

/** 平常を決めるのに要る最小の日数。これに満たない間は傾向を判定しない。 */
export const MIN_BASELINE_DAYS = 3;
/** 平常の基準に使う過去の日数の上限。 */
export const BASELINE_DAYS = 14;

/** エラー行数: これ以上かつ平常の何倍以上なら急増とみなす。 */
const ERROR_SURGE_MIN_LINES = 100;
const ERROR_SURGE_RATIO = 3;
const ERROR_SURGE_WARNING_RATIO = 10;

/** 初めて見るクライアントを気付きに挙げる下限（件数 / 全体に占める割合）。 */
const NEW_SOURCE_MIN_REQUESTS = 100;
const NEW_SOURCE_MIN_SHARE = 0.02;
/** 既知のクライアントが急に増えたとみなす下限と倍率。 */
const SOURCE_SURGE_MIN_REQUESTS = 500;
const SOURCE_SURGE_RATIO = 5;

/** 状態コードの比率を見るのに要る最小のリクエスト数。 */
const STATUS_MIN_REQUESTS = 500;
const SERVER_ERROR_SHARE_WARNING = 0.05;
/** 平常がどうであれ、これを超える 5xx の比率は異常として扱う。 */
const SERVER_ERROR_SHARE_ALWAYS = 0.1;
const SERVER_ERROR_SHARE_RISE = 0.03;
const CLIENT_ERROR_SHARE_RISE = 0.15;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[middle - 1] ?? 0) + upper) / 2;
}

/** 送信元の 24 時間のエラー行数の平常（過去の日ごとの中央値）。 */
export function errorBaseline(
  source: string,
  history: readonly OpsSnapshot[],
): number {
  return median(history.map((h) => h.errorCounts[source] ?? 0));
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/**
 * 傾向を判定できるだけの履歴があるか。**足りない間は黙って通さず**、
 * 呼び出し側が「学習中」と報告できるようにする。
 */
export function hasEnoughHistory(history: readonly OpsSnapshot[]): boolean {
  return history.length >= MIN_BASELINE_DAYS;
}

/** エラー行が平常より急に増えた送信元を挙げる。 */
export function compareErrorCounts(
  today: Readonly<Record<string, number>>,
  history: readonly OpsSnapshot[],
): OpsFinding[] {
  if (!hasEnoughHistory(history)) return [];

  const findings: OpsFinding[] = [];
  for (const [source, count] of Object.entries(today)) {
    const baseline = median(history.map((h) => h.errorCounts[source] ?? 0));
    if (count < ERROR_SURGE_MIN_LINES) continue;
    if (count < baseline * ERROR_SURGE_RATIO) continue;

    const ratio = baseline === 0 ? undefined : count / baseline;
    const heavy =
      baseline === 0
        ? count >= ERROR_SURGE_MIN_LINES * ERROR_SURGE_WARNING_RATIO
        : count >= baseline * ERROR_SURGE_WARNING_RATIO;
    findings.push({
      id: `error-surge:${source}`,
      severity: heavy ? 'warning' : 'notice',
      title:
        ratio === undefined
          ? `${source} でエラー行が出ている（平常は 0 件）`
          : `${source} のエラー行が平常の ${ratio.toFixed(1)} 倍`,
      detail: `24 時間のエラー行 ${count} 件（過去 ${history.length} 日の中央値 ${Math.round(baseline)} 件）`,
    });
  }
  return findings;
}

/**
 * 前回の見回りで報告済みの急増を、いま収まっているかで振り分ける。
 * 収まっていれば外し（`calmed` に鍵を返す）、続いていれば続いていると添える。
 */
export function settleReportedSurges(
  surges: readonly OpsFinding[],
  reported: ReadonlySet<string>,
  stillSurging: ReadonlySet<string>,
): { kept: OpsFinding[]; calmed: string[] } {
  const kept: OpsFinding[] = [];
  const calmed: string[] = [];
  for (const surge of surges) {
    if (!reported.has(surge.id)) {
      kept.push(surge);
    } else if (stillSurging.has(surge.id)) {
      kept.push({
        ...surge,
        detail: `${surge.detail}。前回の見回りでも報告済みで、いまも続いている`,
      });
    } else {
      calmed.push(surge.id);
    }
  }
  return { kept, calmed };
}

/** アクセス元の傾向の変化を挙げる。 */
export function compareClientIps(
  today: Readonly<Record<string, number>>,
  history: readonly OpsSnapshot[],
): OpsFinding[] {
  if (!hasEnoughHistory(history)) return [];

  const known = new Set(history.flatMap((h) => Object.keys(h.clientIps)));
  const total = Object.values(today).reduce((sum, n) => sum + n, 0);
  const newSourceFloor = Math.max(
    NEW_SOURCE_MIN_REQUESTS,
    total * NEW_SOURCE_MIN_SHARE,
  );

  const findings: OpsFinding[] = [];
  for (const [ip, count] of Object.entries(today)) {
    if (!known.has(ip)) {
      if (count < newSourceFloor) continue;
      findings.push({
        id: `new-source:${ip}`,
        severity: 'notice',
        title: `初めて見るアクセス元 ${ip}`,
        detail: `24 時間で ${count} リクエスト（全体の ${percent(total === 0 ? 0 : count / total)}）。過去 ${history.length} 日の上位には現れていない`,
      });
      continue;
    }

    const baseline = median(history.map((h) => h.clientIps[ip] ?? 0));
    if (count < SOURCE_SURGE_MIN_REQUESTS) continue;
    if (count < baseline * SOURCE_SURGE_RATIO) continue;
    findings.push({
      id: `source-surge:${ip}`,
      severity: 'notice',
      title: `アクセス元 ${ip} からのリクエストが急増`,
      detail: `24 時間で ${count} リクエスト（過去 ${history.length} 日の中央値 ${Math.round(baseline)}）`,
    });
  }
  return findings;
}

/** `200` のような状態コードを `2xx` の階級にまとめる。 */
export function statusClassCounts(
  byStatus: Readonly<Record<string, number>>,
): Record<string, number> {
  const classes: Record<string, number> = {};
  for (const [status, count] of Object.entries(byStatus)) {
    const head = status.charAt(0);
    if (!/^[1-5]$/.test(head)) continue;
    const key = `${head}xx`;
    classes[key] = (classes[key] ?? 0) + count;
  }
  return classes;
}

function shareOf(
  counts: Readonly<Record<string, number>>,
  key: string,
): number {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return total === 0 ? 0 : (counts[key] ?? 0) / total;
}

/** 4xx / 5xx の比率が平常から外れていないかを見る。 */
export function compareStatusMix(
  today: Readonly<Record<string, number>>,
  history: readonly OpsSnapshot[],
): OpsFinding[] {
  const total = Object.values(today).reduce((sum, n) => sum + n, 0);
  if (total < STATUS_MIN_REQUESTS) return [];

  const findings: OpsFinding[] = [];
  const serverShare = shareOf(today, '5xx');
  const serverBase = median(history.map((h) => shareOf(h.statusCounts, '5xx')));
  const risen =
    hasEnoughHistory(history) &&
    serverShare >= serverBase + SERVER_ERROR_SHARE_RISE;
  if (
    serverShare >= SERVER_ERROR_SHARE_WARNING &&
    (risen || serverShare >= SERVER_ERROR_SHARE_ALWAYS)
  ) {
    findings.push({
      id: 'status-5xx',
      severity: 'warning',
      title: `5xx の比率が ${percent(serverShare)}`,
      detail: `24 時間の ${total} リクエスト中 ${today['5xx'] ?? 0} 件（平常の中央値 ${percent(serverBase)}）`,
    });
  }

  const clientShare = shareOf(today, '4xx');
  const clientBase = median(history.map((h) => shareOf(h.statusCounts, '4xx')));
  if (
    hasEnoughHistory(history) &&
    clientShare >= clientBase + CLIENT_ERROR_SHARE_RISE
  ) {
    findings.push({
      id: 'status-4xx',
      severity: 'notice',
      title: `4xx の比率が平常より上がっている（${percent(clientShare)}）`,
      detail: `24 時間の ${total} リクエスト中 ${today['4xx'] ?? 0} 件（平常の中央値 ${percent(clientBase)}）`,
    });
  }
  return findings;
}

function jstParts(date: Date): { day: string; hour: number } {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  return {
    day: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
  };
}

export function jstDay(date: Date): string {
  return jstParts(date).day;
}

/**
 * 今日の見回りをもう始めてよいか。**日付は JST**。最後の実行が今日より前で、
 * 設定の時刻を過ぎていれば走る —— 再起動をまたいでも二重に走らず、
 * 止まっていた間の分は起動後の最初の確認で補う。
 */
export function isReviewDue(
  now: Date,
  hourJst: number,
  lastReviewedAt: Date | undefined,
): boolean {
  const current = jstParts(now);
  if (current.hour < hourJst) return false;
  if (!lastReviewedAt) return true;
  return jstParts(lastReviewedAt).day < current.day;
}

/**
 * ログやメトリクスのラベルに混じる秘密を伏せる。**Discord へ出す前と LLM へ
 * 渡す前の両方**で通す。完全ではない（形の決まったものだけ）ので、ここを
 * 通っても「ログに秘密が出ない」保証にはならない。
 */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\b(authorization\s*[:=]\s*)(bearer|basic)\s+[^\s"',;]+/gi, '$1$2 ***'],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  [
    /\b((?:[a-z_-]*)(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key)[a-z_-]*["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    '$1***',
  ],
  [/\b(eyJ[A-Za-z0-9_-]{8,}\.)[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '$1***'],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '$1-***'],
  [/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g, '$1***'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, 'xox*-***'],
  [/\bAKIA[0-9A-Z]{12,}/g, 'AKIA***'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1***@'],
];

export function maskSecrets(text: string): string {
  let masked = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    masked = masked.replace(pattern, replacement);
  }
  return masked;
}

/**
 * 同じ種類のエラー行をまとめるために、行ごとに違う部分を潰す。
 * 時刻・ID・アドレス・数字を置き換えて、先頭の一定長だけ残す。
 */
export function normalizeLogLine(line: string): string {
  return maskSecrets(line)
    .replace(
      /\b\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?/g,
      '<time>',
    )
    .replace(/\b\d{2}\/\d{2}\/\d{2,4} \d{2}:\d{2}:\d{2}\b/g, '<time>')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      '<uuid>',
    )
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<ip>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

export interface LogPattern {
  pattern: string;
  count: number;
  /** この型で最初に見た元の行（正規化していない）。 */
  sample: string;
}

/** 行を正規化して数え、多い順に `top` 種類だけ返す。 */
export function groupLogPatterns(
  lines: readonly string[],
  top: number,
): LogPattern[] {
  const groups = new Map<string, { count: number; sample: string }>();
  for (const line of lines) {
    const key = normalizeLogLine(line);
    if (key === '') continue;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { count: 1, sample: line });
  }
  return [...groups.entries()]
    .map(([pattern, { count, sample }]) => ({ pattern, count, sample }))
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
}

const OVERALL_LABEL: Record<OpsOverall, { emoji: string; text: string }> = {
  ok: { emoji: '🟢', text: '異常なし' },
  notice: { emoji: '🟡', text: '気付き' },
  warning: { emoji: '🟠', text: '要確認' },
  critical: { emoji: '🔴', text: '要対応' },
};

export function overallLabel(overall: OpsOverall): string {
  const { emoji, text } = OVERALL_LABEL[overall];
  return `${emoji} ${text}`;
}

/** 項目に付いた調書から、事実の行を取り出す。調書が無ければ空。 */
export function findingFacts(finding: OpsFinding): string[] {
  return [
    ...(finding.dossier ? renderDossierFacts(finding.dossier) : []),
    ...(finding.restartDossier
      ? renderRestartFacts(finding.restartDossier)
      : []),
  ];
}

/** 言葉にできなかったときの、事実だけの本文。 */
export function renderFindingsText(findings: readonly OpsFinding[]): string {
  if (findings.length === 0) return '気になる点は見つかりませんでした。';
  return sortBySeverity(findings)
    .map((f) =>
      [
        `- ${f.title}`,
        `  ${f.detail}`,
        ...findingFacts(f).map((x) => `  ${x}`),
        ...(f.hypothesis ? [`  ${renderHypothesis(f.hypothesis)}`] : []),
      ].join('\n'),
    )
    .join('\n');
}
