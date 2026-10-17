/**
 * 見回り（F-53）と原因調査（F-54）が共有する、この基盤のログの検索式。
 * 送信元の名前（namespace / `home/<container or unit>`）から検索式を作る。
 */

export const HOUR_MS = 60 * 60 * 1000;
export const WINDOW_MS = 24 * HOUR_MS;

/**
 * ここにあるクエリは**この基盤のログの形を知っている**。ingress の
 * アクセスログは `<ip> - - [<time>] "<method> <path> <proto>" <status> ...`、
 * 同じ namespace のエラーログは別の形（`[error] ...`）で出る。
 */
export const ERROR_WORDS = '(?i)(\\b(error|err|fatal|panic)\\b|oomkill)';
/** アクセスログ行（URL に "error" と書いてあるだけで数えない）。 */
export const ACCESS_LINE = '^[0-9a-fA-F:.]+ - \\S+ \\[';
export const INGRESS_SELECTOR = '{namespace="ingress-nginx"}';

/**
 * スタックトレース・レジスタダンプ・カーネルの警告の本体など、**1 件の出来事の
 * 2 行目以降**。1 行ずつ数えると、例外 1 件が 30 行に、カーネルの警告 1 件が 64 行に
 * 化けて、倍率が桁違いに跳ねる。先頭の行（見出し・例外の本題）だけを数える。
 * CRI の前置き（`<時刻> stderr F `）が付いた形も同じに扱う。
 */
export const CONTINUATION_LINE = String.raw`^(\S+ std(?:out|err) [FP] )?(\s|(?:RIP|RSP|RAX|RBX|RCX|RDX|RSI|RDI|RBP|R[0-9]+|FS|GS|CS|CR[0-9]|DR[0-9]|Code|CPU|Hardware name|Modules linked in|Tainted|Call Trace|PKRU)[: ]|-+\[ (?:cut here|end trace)|</?(?:TASK|IRQ)>|(?:\[[^\]]*\]\s+)?(?:--- End of inner|--->|#{5,})|\[[^\]]*\]\s+at )`;
export const NOT_CONTINUATION = `!~ \`${CONTINUATION_LINE}\``;

/**
 * 24 時間を `SLICE_HOURS` ごとに分けて問い合わせる（`offset` が区間の位置）。
 * Loki は 30 秒ほどで応答を切るので、一括で投げると、中身が合っていても受け取れない。
 */
export const SLICE_HOURS = 2;
export const SLICE_COUNT = 24 / SLICE_HOURS;
/** 「いま収まっているか」を見る直近の区間数（6 時間）。 */
export const RECENT_SLICES = 3;
export const sliceRange = (offsetHours: number) =>
  `[${SLICE_HOURS}h] offset ${offsetHours}h`;

/**
 * journal は優先度のラベルで絞る。本文の正規表現だけで 24 時間ぶんを読むと、
 * ログが洪水になった翌日（7,000 万行）に問い合わせが遅すぎて落ちる。
 */
export const JOURNAL_PRIORITY =
  'priority=~"warning|error|crit.*|alert|emerg.*"';
export const JOURNAL_SELECTOR = `{site="home", job="journal", ${JOURNAL_PRIORITY}}`;

export const HOME_PREFIX = 'home/';
/** `unit` ラベルの無い journal の行（カーネル・監査）の送信元名。 */
export const HOME_NO_UNIT = 'kernel';
export const SYSTEMD_UNIT = /\.(service|scope|socket|timer|mount)$/;

export const SAFE_SOURCE_NAME = /^(home\/)?[\w.@:-]+$/;

/** 送信元の名前から、その代表的なエラー行を引くログクエリを作る。 */
export function evidenceQueryOf(source: string): string {
  const words = `|~ \`${ERROR_WORDS}\` !~ \`${ACCESS_LINE}\` ${NOT_CONTINUATION}`;
  if (!source.startsWith(HOME_PREFIX))
    return `{namespace="${source}"} ${words}`;
  const name = source.slice(HOME_PREFIX.length);
  if (name === HOME_NO_UNIT) {
    return `{site="home", job="journal", unit="", ${JOURNAL_PRIORITY}} ${NOT_CONTINUATION}`;
  }
  return SYSTEMD_UNIT.test(name)
    ? `{site="home", job="journal", unit="${name}", ${JOURNAL_PRIORITY}} ${NOT_CONTINUATION}`
    : `{site="home", job="docker", container_name="${name}"} ${words}`;
}

/**
 * 送信元の周辺で何が起きていたかを広く見るための検索式。エラーの語では絞らない。
 * 洪水の元と、その直前に起きた別の出来事（設定変更・モジュールの着脱）は、
 * 別のユニットや別の優先度の行に出ることが多いので、家の journal は全体を見る。
 */
export function surroundingQueryOf(source: string): string {
  if (!source.startsWith(HOME_PREFIX)) return `{namespace="${source}"}`;
  const name = source.slice(HOME_PREFIX.length);
  return SYSTEMD_UNIT.test(name) || name === HOME_NO_UNIT
    ? '{site="home", job="journal"}'
    : `{site="home", job="docker", container_name="${name}"}`;
}
