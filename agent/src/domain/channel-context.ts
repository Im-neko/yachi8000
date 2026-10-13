/**
 * チャンネルの直近の発言を、会話の文脈としてモデルに渡す形へ整える（D-50）。
 *
 * 会話の履歴（Flue）に残るのは、アシスタントが宛てられたやりとりだけ。
 * アシスタント自身が自分から出した投稿（見回りの結果・リマインダー・通知）や、
 * 他の人・他の Bot の発言は入らない。「ここで 23% って」と指されたときに
 * 何のことか分からない、という形で欠ける。
 *
 * **中身は外部由来のデータ**（他の人や Bot が書いたもの）。呼び出し側は
 * 指示ではなく読み物として囲んで渡す（INV-4）。
 */
export interface ChannelMessage {
  /** メッセージ ID。さらに遡るときの起点になる。 */
  id: string;
  authorName: string;
  /** アシスタント自身の投稿か。 */
  fromAssistant: boolean;
  /** Bot（アシスタントを含む）の投稿か。 */
  fromBot: boolean;
  /** 投稿時刻（ミリ秒）。 */
  postedAt: number;
  /** 本文に embed の見出しと説明を足したもの。 */
  text: string;
}

/** 1 件あたりの文字数。長い貼り付けで文脈が埋まらないようにする。 */
export const CONTEXT_MESSAGE_MAX_CHARS = 800;
/** 全体の文字数。 */
export const CONTEXT_TOTAL_MAX_CHARS = 6_000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（以下略）`;
}

function jstClock(ms: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function labelOf(message: ChannelMessage): string {
  if (message.fromAssistant) return 'あなた（自分の投稿）';
  return message.fromBot ? `${message.authorName}（Bot）` : message.authorName;
}

function lineOf(message: ChannelMessage): string {
  return `[${jstClock(message.postedAt)}] ${labelOf(message)}: ${clip(message.text.trim(), CONTEXT_MESSAGE_MAX_CHARS)}`;
}

/**
 * 古い順に並べた発言のうち、全体の文字数に収まる分を返す。**新しいものを優先して
 * 残す**（直前の発言ほど「これ」「さっきの」の指す先になりやすい）。本文の無い発言は
 * 載せない。最新の 1 件は、それ単体が上限を超えていても残す。
 */
export function fitChannelMessages(messages: readonly ChannelMessage[]): {
  kept: ChannelMessage[];
  dropped: number;
} {
  const candidates = messages.filter((m) => m.text.trim() !== '');
  const kept: ChannelMessage[] = [];
  let total = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const message = candidates[i];
    if (!message) continue;
    const length = lineOf(message).length;
    if (total + length > CONTEXT_TOTAL_MAX_CHARS && kept.length > 0) break;
    kept.unshift(message);
    total += length;
  }
  return { kept, dropped: candidates.length - kept.length };
}

/** 古い順の発言を、モデルに渡す 1 つの文字列にする。削った分は先頭に件数を出す。 */
export function renderChannelContext(
  messages: readonly ChannelMessage[],
): string | undefined {
  const { kept, dropped } = fitChannelMessages(messages);
  if (kept.length === 0) return undefined;
  return [
    ...(dropped > 0 ? [`（これより古い ${dropped} 件は省略）`] : []),
    ...kept.map(lineOf),
  ].join('\n');
}
