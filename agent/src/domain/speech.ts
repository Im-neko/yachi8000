/**
 * 発話の優先度（F-17, INV-5）。強い順に reminder → notification → reply。
 *
 * リマインダーが通知より先なのは、**利用者がその時刻を指定したから**。
 * 外部通知は届いた時刻が送信元の都合で決まるので、譲る側になる（→ D-23）。
 */
export type SpeechPriority = 'reminder' | 'notification' | 'reply';

/** 強い順。キューの取り出し順はこの配列が正典。 */
export const SPEECH_PRIORITIES: readonly SpeechPriority[] = [
  'reminder',
  'notification',
  'reply',
];

/**
 * 読み上げるときに URL の代わりに読む語。
 *
 * 消すだけにしないのは、「詳しくは https://… を見て」が「詳しくは を見て」に
 * なると文として壊れるため。本文が URL だけのときも無音にならない。
 */
const URL_SPOKEN_AS = 'リンク';

/**
 * Markdown のリンクは**表示文字列だけ残す**。`[議事録](https://…)` は
 * 「議事録」と読めば通じるので、`リンク` に潰すより情報が多い。
 */
const MARKDOWN_LINK = /\[([^\]\n]+)\]\((?:https?:\/\/|www\.)[^\s)]*\)/g;

/** Discord が埋め込みを抑制するときの `<https://…>` 形式。 */
const ANGLE_BRACKET_URL = /<(?:https?:\/\/|www\.)[^\s<>]*>/g;

/**
 * URL 本体。空白・山括弧・引用符・日本語の括弧は URL に含めない。
 *
 * **スキーム（または `www.`）が無いものは URL として扱わない。** `example.com`
 * まで拾いにいくと `Node.js` や `v1.2` のような普通の語を巻き込む。読み落とす
 * ほうが、読むべき語を消すより害が小さい。
 */
const URL = /(?:https?:\/\/|www\.)[^\s<>"'「」『』（）【】]*/g;

/**
 * URL の末尾に紛れ込みやすい記号。`https://example.com/。` の句点まで URL
 * 扱いすると、文の切れ目（D-11）が消えてしまう。
 */
const TRAILING_PUNCTUATION = /[.,;:!?。、！？）)」』】]+$/;

/**
 * 読み上げからリンクを外す。
 *
 * URL を音にしても意味が取れないうえ、`https://example.com/a/b?c=d` のような
 * 文字列は延々と続く。**テキスト側からは消さない** —— チャンネルへ出す文面で
 * URL は押せる情報なので、これは読み上げ側だけの整形。
 *
 * LLM に書き換えさせないのは意図的。決定的な置換なので、リマインダーの
 * 「保存した文面をそのまま読む」（D-08）とも衝突しない —— 言い換えではなく、
 * 音にできないものを音にしないだけ。
 */
export function stripUrlsForSpeech(text: string): string {
  return text
    .replace(MARKDOWN_LINK, '$1')
    .replace(ANGLE_BRACKET_URL, URL_SPOKEN_AS)
    .replace(URL, (match) => {
      const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
      return URL_SPOKEN_AS + trailing;
    });
}

/**
 * 1 文の上限。VOICEVOX は長文もそのまま合成できるが、合成が終わるまで
 * 音が出ない。文が長いほど「最初の音まで」が延び、割り込み（F-17）の
 * 粒度も粗くなる。
 */
const MAX_SENTENCE_LENGTH = 120;

/** 読点で切る候補を探す下限。これより手前で切ると細切れになる。 */
const MIN_SPLIT_LENGTH = 40;

const SENTENCE_BOUNDARY = /(?<=[。．！？!?])/;

/**
 * 読み上げ用に文へ分割する（D-11）。
 *
 * 分割の目的は「最初の音が出るまで」を縮めることと、通知が文の切れ目で
 * 割り込めるようにすること（Q-05 → (b)）。どちらもこの純関数の粒度で決まる。
 */
export function splitIntoSentences(text: string): string[] {
  return text
    .split(/\r?\n/)
    .flatMap((line) => line.split(SENTENCE_BOUNDARY))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '')
    .flatMap(splitLongSentence);
}

/** 句点が無いまま伸びた文を、読点（無ければ強制）で切る。 */
function splitLongSentence(sentence: string): string[] {
  const parts: string[] = [];
  let rest = sentence;

  while (rest.length > MAX_SENTENCE_LENGTH) {
    const head = rest.slice(0, MAX_SENTENCE_LENGTH);
    const comma = Math.max(head.lastIndexOf('、'), head.lastIndexOf('，'));
    const cut = comma >= MIN_SPLIT_LENGTH ? comma + 1 : MAX_SENTENCE_LENGTH;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest !== '') parts.push(rest);
  return parts;
}
