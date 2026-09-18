import type { Settings } from './settings.ts';

/** 出典になった Discord の投稿。Issue 本文の先頭に必ず置く。 */
export interface IssueSource {
  /** 投稿のパーマリンク。`https://discord.com/channels/<guild>/<channel>/<message>` */
  url: string;
  /** 投稿日（JST の YYYY-MM-DD）。 */
  postedOn: string;
  /** 投稿の本文。長いものは引用側で切る。 */
  text: string;
}

export interface IssueDraft {
  title: string;
  body: string;
  labels: readonly string[];
}

export interface CreatedIssue {
  number: number;
  url: string;
}

/** 引用に載せる元投稿の上限。これを超えたら切って、続きは出典リンクに預ける。 */
const EXCERPT_LIMIT = 1500;

export function formatJstDate(date: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * どのリポジトリへ立てるかはチャンネルで決まる（D-32）。
 *
 * 設定に無いチャンネルでは起票しない。既定のリポジトリへ倒すと、雑談の
 * チャンネルで「Issue にしといて」と言われたときに黙って本番リポジトリへ
 * 立つ。どこへ立つかは設定を書いた人にしか決められない。
 */
export function repositoryForChannel(
  settings: Settings,
  channelId: string,
): string | undefined {
  return settings.issueTracker?.repositories[channelId];
}

function quote(text: string): string {
  const trimmed =
    text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}…` : text;
  return trimmed
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * Issue 本文を組み立てる。
 *
 * **出典ブロックはここで前置する。** モデルが書いた本文にリンクを混ぜて
 * もらう形にすると、書き忘れた Issue が混ざる。出典の Discord リンクは
 * stocktrade 側の日次棚卸し（memo-triage）が二重起票を避けるための
 * 照合キーでもあるので、欠けると夜に同じ Issue がもう1本立つ。
 */
export function buildIssueBody(input: {
  source: IssueSource;
  /** メンションで言われたこと。そのまま載せる。 */
  instruction: string;
  /** モデルが組み立てた本文。 */
  body: string;
}): string {
  const sections = [
    '## 出典',
    '',
    `Discord: ${input.source.url}（${input.source.postedOn} 投稿）`,
    '',
    quote(input.source.text),
    '',
    '## 依頼',
    '',
    input.instruction.trim(),
    '',
    input.body.trim(),
  ];
  return sections.join('\n');
}
