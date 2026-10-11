import { randomUUID } from 'node:crypto';
import {
  BASELINE_DAYS,
  compareClientIps,
  compareErrorCounts,
  compareStatusMix,
  groupLogPatterns,
  hasEnoughHistory,
  isReviewDue,
  jstDay,
  type MetricSample,
  MIN_BASELINE_DAYS,
  maskSecrets,
  maxSeverity,
  type OpsFinding,
  type OpsSeverity,
  type OpsSnapshot,
  overallLabel,
  overallSeverity,
  renderFindingsText,
  sortBySeverity,
  statusClassCounts,
} from '../domain/ops.ts';
import type { LogSource } from '../domain/ports/log-source.ts';
import type { MetricSource } from '../domain/ports/metric-source.ts';
import type { OpsNarrator } from '../domain/ports/ops-narrator.ts';
import type {
  OpsReviewRecord,
  OpsReviewStore,
} from '../domain/ports/ops-review-store.ts';
import type { SettingsProvider } from '../domain/ports/settings-provider.ts';
import type { TextNotifier } from '../domain/ports/text-notifier.ts';

/** 日次の見回りの既定。設定ファイルの `opsReview` で上書きできる。 */
const DEFAULT_HOUR_JST = 8;
const DEFAULT_CHANNEL = 'monitoring';

/** 傾向が動いた送信元について、代表的な行を拾う件数。 */
const EVIDENCE_SOURCES = 5;
const EVIDENCE_FETCH_LINES = 300;
const EVIDENCE_PATTERNS = 4;

/** 同じ種類の項目を 1 回の報告に載せる数。溢れた日でも読める量に絞る。 */
const MAX_FINDINGS_PER_KIND = 8;

/** チャットから問い合わせるときの上限。重いクエリで基盤を詰まらせない。 */
export const MAX_QUERY_MINUTES = 24 * 60;
export const MAX_QUERY_LINES = 100;

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * ここにあるクエリは**この基盤のログの形を知っている**。ingress の
 * アクセスログは `<ip> - - [<time>] "<method> <path> <proto>" <status> ...`、
 * 同じ namespace のエラーログは別の形（`[error] ...`）で出る。
 */
const ERROR_WORDS = '(?i)(\\b(error|err|fatal|panic)\\b|oomkill)';
/** アクセスログ行（URL に "error" と書いてあるだけで数えない）。 */
const ACCESS_LINE = '^[0-9a-fA-F:.]+ - \\S+ \\[';
const INGRESS_SELECTOR = '{namespace="ingress-nginx"}';

const ERROR_COUNT_QUERY = `sum by (namespace) (count_over_time({namespace=~".+"} |~ \`${ERROR_WORDS}\` !~ \`${ACCESS_LINE}\` [24h]))`;
/**
 * 家のログ（Alloy が `site="home"` を付けて送ってくる）。Docker は
 * `container_name`、journal は `unit` で分ける。送信元の名前は `home/` を
 * 前置きして、クラスタの namespace と混ざらないようにする。
 */
const HOME_CONTAINER_ERROR_QUERY = `sum by (container_name) (count_over_time({site="home", job="docker"} |~ \`${ERROR_WORDS}\` !~ \`${ACCESS_LINE}\` [24h]))`;
const HOME_UNIT_ERROR_QUERY = `sum by (unit) (count_over_time({site="home", job="journal"} |~ \`${ERROR_WORDS}\` [24h]))`;
const HOME_PREFIX = 'home/';
const SYSTEMD_UNIT = /\.(service|scope|socket|timer|mount)$/;

const CLIENT_IP_QUERY = `topk(50, sum by (ip) (count_over_time(${INGRESS_SELECTOR} | regexp \`^(?P<ip>[0-9a-fA-F:.]+) - \` | ip != "" [24h])))`;
const STATUS_QUERY = `sum by (status) (count_over_time(${INGRESS_SELECTOR} | regexp \`"[A-Z]+ [^"]*" (?P<status>[0-9]{3}) \` | status != "" [24h]))`;

export interface OpsLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface OpsQueryDependencies {
  logs: LogSource;
  metrics: MetricSource;
}

export interface OpsReviewDependencies extends OpsQueryDependencies {
  store: OpsReviewStore;
  narrator: OpsNarrator;
  text: TextNotifier;
  settings: SettingsProvider;
  log: OpsLogger;
}

/** チャットの道具が使う側。読むのに加えて、見回りの直近の結果を引く。 */
export type OpsToolDependencies = OpsQueryDependencies &
  Pick<OpsReviewDependencies, 'store'>;

interface MetricCheck {
  id: string;
  title: string;
  query: string;
  /** サンプルの値から重大度を決める。`undefined` は数えない。 */
  severityOf(value: number): OpsSeverity | undefined;
  describe(sample: MetricSample): string;
}

function label(sample: MetricSample, key: string): string {
  return sample.labels[key] ?? '?';
}

function podName(sample: MetricSample): string {
  return `${label(sample, 'namespace')}/${label(sample, 'pod')}`;
}

function atLeast(
  threshold: number,
  severity: OpsSeverity,
  otherwise: OpsSeverity,
  value: number,
): OpsSeverity {
  return value >= threshold ? severity : otherwise;
}

/**
 * しきい値型の確認。**ベースラインを要らない**ものだけをここに置く。
 * 傾向の判定（ログ・アクセス元）は別（`runOpsReview`）。
 */
const METRIC_CHECKS: readonly MetricCheck[] = [
  {
    id: 'alerts',
    title: '発火中のアラート',
    query: 'ALERTS{alertstate="firing",alertname!~"Watchdog|InfoInhibitor"}',
    severityOf: () => 'notice',
    describe: (s) =>
      `${label(s, 'alertname')}（${label(s, 'severity')}）${s.labels.namespace ? ` ${s.labels.namespace}` : ''}`,
  },
  {
    id: 'restarts',
    title: '24 時間以内に再起動したコンテナ',
    query: 'increase(kube_pod_container_status_restarts_total[24h]) > 0.5',
    severityOf: (v) => atLeast(5, 'warning', 'notice', v),
    describe: (s) =>
      `${podName(s)}:${label(s, 'container')} ×${Math.round(s.value)}`,
  },
  {
    id: 'oom',
    title: 'メモリ不足で落とされたコンテナ',
    query:
      '(kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1) and on(namespace,pod,container) (increase(kube_pod_container_status_restarts_total[24h]) > 0.5)',
    severityOf: () => 'warning',
    describe: (s) => `${podName(s)}:${label(s, 'container')}`,
  },
  {
    id: 'pvc',
    title: '容量が逼迫しているボリューム',
    query:
      'kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes > 0.8',
    severityOf: (v) => atLeast(0.9, 'critical', 'warning', v),
    describe: (s) =>
      `${label(s, 'namespace')}/${label(s, 'persistentvolumeclaim')} ${Math.round(s.value * 100)}%`,
  },
  {
    id: 'node-disk',
    title: '容量が逼迫しているノードのディスク',
    query:
      '1 - node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs"} / node_filesystem_size_bytes > 0.85',
    severityOf: (v) => atLeast(0.95, 'critical', 'warning', v),
    describe: (s) =>
      `${label(s, 'instance')}:${label(s, 'mountpoint')} ${Math.round(s.value * 100)}%`,
  },
  {
    id: 'node-memory',
    title: 'メモリの使用率が高いノード',
    query:
      '1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes > 0.9',
    severityOf: () => 'warning',
    describe: (s) => `${label(s, 'instance')} ${Math.round(s.value * 100)}%`,
  },
  {
    id: 'node-ready',
    title: 'Ready でないノード',
    query: 'kube_node_status_condition{condition="Ready",status="true"} == 0',
    severityOf: () => 'critical',
    describe: (s) => label(s, 'node'),
  },
  {
    id: 'probe',
    title: '死活監視に失敗しているエンドポイント',
    query: 'probe_success == 0',
    severityOf: () => 'warning',
    describe: (s) => label(s, 'instance'),
  },
  {
    id: 'cert',
    title: '証明書の期限が近いエンドポイント',
    query: '(probe_ssl_earliest_cert_expiry - time()) / 86400 < 14',
    severityOf: (v) => (v < 3 ? 'critical' : 'warning'),
    describe: (s) => `${label(s, 'instance')} 残り ${s.value.toFixed(1)} 日`,
  },
  {
    id: 'targets-down',
    title: '収集できていない監視対象',
    query: 'up == 0',
    severityOf: () => 'warning',
    describe: (s) => `${label(s, 'job')} ${label(s, 'instance')}`,
  },
];

const MAX_ITEMS_PER_FINDING = 8;

function checkFailed(id: string, what: string, error: unknown): OpsFinding {
  return {
    id: `check-failed:${id}`,
    severity: 'warning',
    title: `${what}を確認できなかった`,
    detail: `問い合わせに失敗: ${(error as Error).message}`,
  };
}

/** しきい値型の確認を走らせる。**確認できなかったものは項目として返す。** */
async function runMetricChecks(
  deps: OpsQueryDependencies,
  now: Date,
): Promise<OpsFinding[]> {
  const outcomes = await Promise.allSettled(
    METRIC_CHECKS.map((check) =>
      deps.metrics.instant({ promql: check.query, at: now }),
    ),
  );

  const findings: OpsFinding[] = [];
  outcomes.forEach((outcome, index) => {
    const check = METRIC_CHECKS[index];
    if (!check) return;
    if (outcome.status === 'rejected') {
      findings.push(checkFailed(check.id, check.title, outcome.reason));
      return;
    }

    const hits = outcome.value
      .map((sample) => ({ sample, severity: check.severityOf(sample.value) }))
      .filter(
        (hit): hit is { sample: MetricSample; severity: OpsSeverity } =>
          hit.severity !== undefined,
      );
    if (hits.length === 0) return;

    const described = hits.map((hit) => check.describe(hit.sample));
    const shown = described.slice(0, MAX_ITEMS_PER_FINDING).join(' / ');
    const rest = described.length - MAX_ITEMS_PER_FINDING;
    findings.push({
      id: `metric:${check.id}`,
      severity: maxSeverity(hits.map((hit) => hit.severity)),
      title: `${check.title}（${hits.length} 件）`,
      detail: rest > 0 ? `${shown} ほか ${rest} 件` : shown,
    });
  });
  return findings;
}

function toCounts(
  samples: readonly MetricSample[],
  key: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const sample of samples) {
    const name = sample.labels[key];
    if (name) counts[name] = (counts[name] ?? 0) + Math.round(sample.value);
  }
  return counts;
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return Promise.allSettled([promise]).then(
    ([result]) => result as PromiseSettledResult<T>,
  );
}

/**
 * 集計を取る。**1 つでも取れなかったら snapshot は返さない** —— 欠けた集計を
 * 「その日は 0 件だった」として残すと、翌日以降の平常を壊す。
 */
async function collectSnapshot(
  deps: OpsQueryDependencies,
  now: Date,
): Promise<{ snapshot?: OpsSnapshot; failures: OpsFinding[] }> {
  // Loki は小さい構成なので、問い合わせは直列に投げる（並列にすると
  // `429 too many outstanding requests` で落ちる）。
  const run = (logql: string) => settle(deps.logs.metric({ logql, at: now }));
  const errors = await run(ERROR_COUNT_QUERY);
  const homeContainers = await run(HOME_CONTAINER_ERROR_QUERY);
  const homeUnits = await run(HOME_UNIT_ERROR_QUERY);
  const ips = await run(CLIENT_IP_QUERY);
  const statuses = await run(STATUS_QUERY);

  const parts = [
    { id: 'log-errors', what: 'エラーログの集計', result: errors },
    {
      id: 'log-home-containers',
      what: '家のコンテナのエラーログの集計',
      result: homeContainers,
    },
    {
      id: 'log-home-units',
      what: '家の journal のエラーログの集計',
      result: homeUnits,
    },
    { id: 'log-clients', what: 'アクセス元の集計', result: ips },
    { id: 'log-status', what: '状態コードの集計', result: statuses },
  ];
  const failures = parts.flatMap((part) =>
    part.result.status === 'rejected'
      ? [checkFailed(part.id, part.what, part.result.reason)]
      : [],
  );
  if (
    errors.status === 'rejected' ||
    homeContainers.status === 'rejected' ||
    homeUnits.status === 'rejected' ||
    ips.status === 'rejected' ||
    statuses.status === 'rejected'
  ) {
    return { failures };
  }

  const errorCounts = toCounts(errors.value, 'namespace');
  for (const [key, count] of Object.entries(
    toCounts(homeContainers.value, 'container_name'),
  )) {
    errorCounts[`${HOME_PREFIX}${key}`] = count;
  }
  for (const [key, count] of Object.entries(
    toCounts(homeUnits.value, 'unit'),
  )) {
    errorCounts[`${HOME_PREFIX}${key}`] = count;
  }

  return {
    failures,
    snapshot: {
      errorCounts,
      clientIps: toCounts(ips.value, 'ip'),
      statusCounts: statusClassCounts(toCounts(statuses.value, 'status')),
    },
  };
}

/** 送信元の名前から、その代表行を引くログセレクタを作る。 */
function selectorOf(source: string): string {
  if (!source.startsWith(HOME_PREFIX)) return `{namespace="${source}"}`;
  const name = source.slice(HOME_PREFIX.length);
  return SYSTEMD_UNIT.test(name)
    ? `{site="home", job="journal", unit="${name}"}`
    : `{site="home", job="docker", container_name="${name}"}`;
}

const SAFE_SOURCE_NAME = /^(home\/)?[\w.@:-]+$/;

/** 急増した送信元の、代表的なエラー行を付ける。取れなくても項目は残す。 */
async function attachEvidence(
  deps: OpsQueryDependencies,
  findings: OpsFinding[],
  now: Date,
  notes: string[],
): Promise<void> {
  const surges = sortBySeverity(
    findings.filter((f) => f.id.startsWith('error-surge:')),
  ).slice(0, EVIDENCE_SOURCES);

  for (const finding of surges) {
    const source = finding.id.slice('error-surge:'.length);
    if (!SAFE_SOURCE_NAME.test(source)) continue;
    try {
      const lines = await deps.logs.lines({
        logql: `${selectorOf(source)} |~ \`${ERROR_WORDS}\` !~ \`${ACCESS_LINE}\``,
        start: new Date(now.getTime() - WINDOW_MS),
        end: now,
        limit: EVIDENCE_FETCH_LINES,
      });
      finding.evidence = groupLogPatterns(
        lines.map((l) => l.line),
        EVIDENCE_PATTERNS,
      ).map(({ pattern, count }) => `${count}× ${pattern}`);
    } catch (error) {
      notes.push(
        `${source} の代表的なエラー行を取れなかった（${(error as Error).message}）`,
      );
    }
  }
}

/**
 * 同じ種類の項目が溢れた日に、本文が項目の羅列で埋まらないようにする。
 * 重いものから残し、削った数は注記に出す（黙って落とさない）。
 */
function capFindings(
  findings: OpsFinding[],
  prefix: string,
  max: number,
  notes: string[],
): OpsFinding[] {
  const matching = sortBySeverity(
    findings.filter((f) => f.id.startsWith(prefix)),
  );
  if (matching.length <= max) return findings;
  const dropped = new Set(matching.slice(max));
  notes.push(
    `${prefix.replace(/:$/, '')} は他に ${dropped.size} 件あり、重い順に ${max} 件だけ載せた`,
  );
  return findings.filter((f) => !dropped.has(f));
}

/**
 * 見回りを 1 回行う（F-53）。**異常の有無はここで決める。** LLM は
 * 見つかったものを言葉にするだけ。
 *
 * 一部の問い合わせが落ちても見回りは続け、落ちたこと自体を項目にする
 * （INV-7）—— 収集が止まっているのに「異常なし」と言うのが最悪の壊れ方。
 */
export async function runOpsReview(
  deps: OpsReviewDependencies,
  now: Date,
): Promise<OpsReviewRecord> {
  const history = deps.store.recentSnapshots(BASELINE_DAYS);
  const notes: string[] = [];

  const [metricFindings, collected] = await Promise.all([
    runMetricChecks(deps, now),
    collectSnapshot(deps, now),
  ]);

  let findings: OpsFinding[] = [...metricFindings, ...collected.failures];
  const { snapshot } = collected;

  if (snapshot) {
    if (hasEnoughHistory(history)) {
      findings.push(
        ...compareErrorCounts(snapshot.errorCounts, history),
        ...compareClientIps(snapshot.clientIps, history),
      );
    } else {
      notes.push(
        `ログとアクセス元の傾向は学習中（${history.length}/${MIN_BASELINE_DAYS} 日。足りるまでは急増を判定しない）`,
      );
    }
    // 5xx が常に高い、は履歴が無くても言える。
    findings.push(...compareStatusMix(snapshot.statusCounts, history));
    findings = capFindings(
      findings,
      'error-surge:',
      MAX_FINDINGS_PER_KIND,
      notes,
    );
    findings = capFindings(
      findings,
      'new-source:',
      MAX_FINDINGS_PER_KIND,
      notes,
    );
    await attachEvidence(deps, findings, now, notes);
  } else {
    notes.push('ログの集計が揃わなかったため、今日の分は平常の基準に残さない');
  }

  const sorted = sortBySeverity(findings);
  const record: OpsReviewRecord = {
    id: randomUUID(),
    reviewedAt: now.toISOString(),
    status: 'completed',
    severity: overallSeverity(sorted),
    findings: sorted,
    snapshot,
    notes,
  };

  if (sorted.length > 0) {
    try {
      record.narration = await deps.narrator.narrate({
        day: jstDay(now),
        findings: sorted,
        notes,
      });
    } catch (error) {
      deps.log.warn(
        { err: error },
        'Failed to narrate the ops review — falling back to the plain findings',
      );
    }
  }
  return record;
}

export interface OpsReviewSettings {
  hourJst: number;
  channel: string;
  postWhenHealthy: boolean;
}

export function resolveOpsReviewSettings(
  deps: Pick<OpsReviewDependencies, 'settings'>,
): OpsReviewSettings {
  const configured = deps.settings.get().opsReview;
  return {
    hourJst: configured?.hourJst ?? DEFAULT_HOUR_JST,
    channel: configured?.channel ?? DEFAULT_CHANNEL,
    postWhenHealthy: configured?.postWhenHealthy ?? false,
  };
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Discord へ出す本文。**マスクは出口で必ず通す。** */
export function composeReviewMessage(record: OpsReviewRecord): string {
  const day = jstDay(new Date(record.reviewedAt));
  if (record.status === 'failed') {
    return `🔴 日次レビュー ${day}: 見回り自体が失敗しました\n${maskSecrets(record.error ?? '原因不明')}`;
  }
  const body =
    record.narration ??
    [
      renderFindingsText(record.findings),
      ...record.findings.flatMap((f) =>
        (f.evidence ?? []).map((e) => `  ${f.id}: ${e}`),
      ),
    ].join('\n');
  const notes =
    record.notes.length > 0 ? `\n（${record.notes.join(' / ')}）` : '';
  return truncate(
    maskSecrets(
      `${overallLabel(record.severity)} 日次レビュー ${day}\n${body}${notes}`,
    ),
    2_000,
  );
}

/** 見回りの結果をチャンネルへ出す。出せなくても記録は残る。 */
export async function deliverOpsReview(
  deps: OpsReviewDependencies,
  record: OpsReviewRecord,
): Promise<boolean> {
  const config = resolveOpsReviewSettings(deps);
  if (record.severity === 'ok' && !config.postWhenHealthy) {
    deps.log.info(
      { reviewId: record.id },
      'Ops review found nothing to report',
    );
    return false;
  }

  const channel = deps.settings.get().notification.channels?.[config.channel];
  if (!channel) {
    deps.log.warn(
      { reviewId: record.id, channel: config.channel },
      'Ops review not delivered — the channel is not defined in notification.channels',
    );
    return false;
  }

  try {
    await deps.text.send(channel.channelId, composeReviewMessage(record));
    return true;
  } catch (error) {
    deps.log.error(
      { err: error, reviewId: record.id },
      'Failed to deliver the ops review',
    );
    return false;
  }
}

/**
 * 今日の見回りが済んでいなければ行って、結果を残し、配信する。
 *
 * **落ちた見回りも「今日の分」として残す。** 残さないと次の確認でまた走り、
 * 失敗の通知が確認のたびに届く。落ちたことは本文に出す。
 */
export async function runDueOpsReview(
  deps: OpsReviewDependencies,
  now: Date,
): Promise<boolean> {
  const config = resolveOpsReviewSettings(deps);
  const last = deps.store.latest();
  if (
    !isReviewDue(
      now,
      config.hourJst,
      last ? new Date(last.reviewedAt) : undefined,
    )
  ) {
    return false;
  }

  let record: OpsReviewRecord;
  try {
    record = await runOpsReview(deps, now);
  } catch (error) {
    deps.log.error({ err: error }, 'The ops review failed');
    record = {
      id: randomUUID(),
      reviewedAt: now.toISOString(),
      status: 'failed',
      severity: 'critical',
      findings: [],
      error: (error as Error).message,
      notes: [],
    };
  }
  deps.store.save(record);
  deps.log.info(
    {
      reviewId: record.id,
      status: record.status,
      severity: record.severity,
      findings: record.findings.length,
    },
    'Ops review finished',
  );
  await deliverOpsReview(deps, record);
  return true;
}

export function latestOpsReview(
  deps: Pick<OpsReviewDependencies, 'store'>,
): OpsReviewRecord | undefined {
  return deps.store.latest();
}

/** 今この瞬間のしきい値型の確認（チャットの「いまどう?」用）。 */
export function checkClusterHealth(
  deps: OpsQueryDependencies,
  now: Date,
): Promise<OpsFinding[]> {
  return runMetricChecks(deps, now).then(sortBySeverity);
}

export interface LogLinesRequest {
  logql: string;
  minutes: number;
  limit: number;
}

function boundedMinutes(minutes: number): number {
  return Math.min(Math.max(1, Math.floor(minutes)), MAX_QUERY_MINUTES);
}

/** ログ行を引く。**範囲と件数に上限**があり、返す行は秘密を伏せてある。 */
export async function queryLogLines(
  deps: OpsQueryDependencies,
  request: LogLinesRequest,
  now: Date,
): Promise<{ timestamp: string; source: string; line: string }[]> {
  const lines = await deps.logs.lines({
    logql: request.logql,
    start: new Date(now.getTime() - boundedMinutes(request.minutes) * 60_000),
    end: now,
    limit: Math.min(Math.max(1, Math.floor(request.limit)), MAX_QUERY_LINES),
  });
  return lines.map((l) => ({
    timestamp: l.timestamp,
    source: l.labels.pod ?? l.labels.container_name ?? l.labels.job ?? '?',
    line: maskSecrets(l.line).slice(0, 500),
  }));
}

export function queryLogMetric(
  deps: OpsQueryDependencies,
  logql: string,
  now: Date,
): Promise<MetricSample[]> {
  return deps.logs.metric({ logql, at: now });
}

export function queryMetric(
  deps: OpsQueryDependencies,
  promql: string,
  now: Date,
): Promise<MetricSample[]> {
  return deps.metrics.instant({ promql, at: now });
}
