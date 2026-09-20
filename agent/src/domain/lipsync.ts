/**
 * リップシンクの口形列（F-21）。
 *
 * **素材は `/audio_query` のモーラだけ**（→ Q-07 決着、D-38）。音量エンベロープは
 * 取らない。**長さは常に等倍で返ってくる**ので、実際に鳴る時刻にするには
 * `speedScale` で割る —— 伸縮は `/synthesis` の側で全体に一律に掛かる（実測）。
 */

/** VRM 1.0 の口形プリセット。`sil` は「口を閉じる」（プリセット名ではない）。 */
export type Viseme = 'aa' | 'ih' | 'ou' | 'ee' | 'oh' | 'sil';

/** 実際に VRM の Expression として設定できる口形。`sil` は全部 0 にする。 */
export const MOUTH_VISEMES: readonly Viseme[] = ['aa', 'ih', 'ou', 'ee', 'oh'];

/**
 * 母音 → 口形（→ D-38 の 2）。
 *
 * **無声化母音（`A I U E O`）も同じ口形にする。** 声は出ないが口は動くので、
 * 閉じてしまうと「シャツ」の「ツ」で口が止まって見える。`N`（撥音）・
 * `cl`（促音）・`pau`（句読点の間）は口を閉じる。
 */
const VOWEL_TO_VISEME: Record<string, Viseme> = {
  a: 'aa',
  i: 'ih',
  u: 'ou',
  e: 'ee',
  o: 'oh',
};

/** `/audio_query` の 1 モーラ。リップシンクに要る分だけを持つ。 */
export interface Mora {
  /** `a` `i` `u` `e` `o` / `A` `I` `U` `E` `O` / `N` `cl` `pau`。 */
  readonly vowel: string;
  readonly vowelLength: number;
  /** 子音は無いことがある（母音だけのモーラ・`pause_mora`）。 */
  readonly consonantLength?: number | null;
}

/** 口形が切り替わる 1 点。 */
export interface VisemeFrame {
  /** 発話の先頭からの秒数。**再生を始めた時刻からの相対**。 */
  readonly at: number;
  readonly viseme: Viseme;
}

export interface VisemeTimeline {
  readonly frames: readonly VisemeFrame[];
  /** 発話全体の長さ（秒）。 */
  readonly duration: number;
}

export interface BuildVisemeTimelineInput {
  /** 時系列順。`pause_mora` も同じ列に混ぜて渡す。 */
  readonly moras: readonly Mora[];
  /** `/synthesis` に実際に渡した値。設定を読み直さず、送った値をそのまま使う。 */
  readonly speedScale: number;
  /** `prePhonemeLength`（等倍）。 */
  readonly leadingSilence: number;
  /** `postPhonemeLength`（等倍）。 */
  readonly trailingSilence: number;
}

/**
 * モーラの列から口形列を組み立てる。
 *
 * **口形は母音が鳴り始める時刻で切り替える** —— 子音の間は前の母音の口が
 * 残る。実際の口の動きもそうなっている（子音は前の母音から次の母音への
 * 渡りの中で作られる）ので、子音ごとに口を閉じるより自然に見える。
 *
 * **同じ口形が続くところはまとめる。** `「あ」「か」` のように母音が続くと
 * 同じ点が並び、受け取る側が無駄に Expression を書き換えることになる。
 */
export function buildVisemeTimeline(
  input: BuildVisemeTimelineInput,
): VisemeTimeline {
  const { moras, speedScale, leadingSilence, trailingSilence } = input;
  if (speedScale <= 0) {
    throw new Error(`speedScale は正の数である必要があります: ${speedScale}`);
  }

  const frames: VisemeFrame[] = [];
  let last: Viseme | undefined;

  function push(at: number, viseme: Viseme): void {
    if (viseme === last) return;
    frames.push({ at: round(at), viseme });
    last = viseme;
  }

  let elapsed = leadingSilence / speedScale;
  push(0, 'sil');

  for (const mora of moras) {
    elapsed += (mora.consonantLength ?? 0) / speedScale;
    push(elapsed, visemeOf(mora.vowel));
    elapsed += mora.vowelLength / speedScale;
  }

  // 最後は必ず閉じる。開いたまま終わると、次の発話まで口が開きっぱなしになる。
  push(elapsed, 'sil');

  return { frames, duration: round(elapsed + trailingSilence / speedScale) };
}

/**
 * 0.1ms まで丸める。足し込みの誤差（`0.1 + 0.2` が `0.30000000000000004` に
 * なる類）をそのまま載せない —— 口形の精度としては過剰で、配る JSON が
 * 無駄に長くなるだけ。
 */
function round(seconds: number): number {
  return Math.round(seconds * 10_000) / 10_000;
}

/** 未知の音素は口を閉じる。**推測で母音に寄せない**（エンジンを差し替えたときに嘘の口が動く）。 */
function visemeOf(vowel: string): Viseme {
  return VOWEL_TO_VISEME[vowel.toLowerCase()] ?? 'sil';
}
