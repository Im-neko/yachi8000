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
