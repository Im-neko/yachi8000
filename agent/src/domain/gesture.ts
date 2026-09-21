/**
 * 発話に合わせた身振り（F-25, → D-42）。
 *
 * **表情（F-24）と同じ判断で決まるが、出す条件はずっと厳しい。** 表情の
 * 外れは「微妙な顔」で済むが、**身振りの外れは目に刺さる** —— 何でもない
 * 返事で手を振られると、会っている感じどころか壊れて見える。
 *
 * **素材はモデルと同じく運用者が置く**（VRMA ファイル。→ D-42 の 2）。
 * ここにあるのは「どの種類があるか」だけで、実体の在りかは設定ファイル。
 */

/**
 * 出せる身振りの種類。**固定の語彙**にする。
 *
 * 設定で種類そのものを増やせるようにすると、判断を頼むときの説明文も
 * 設定から組み立てることになり、**プロンプトが利用者ごとに変わって
 * 再現しなくなる。** 種類はここで決め、どのファイルを当てるかだけを
 * 設定に持たせる。
 */
export const AVATAR_GESTURES = [
  /** 頷く。同意・了解・相槌。 */
  'nod',
  /** 首をかしげる。疑問・迷い。 */
  'tilt',
  /** 手を振る。挨拶・呼びかけ。 */
  'wave',
  /** お辞儀。謝る・礼を言う。 */
  'bow',
  /** 肩をすくめる。分からない・どうしようもない。 */
  'shrug',
  /** 示す。説明する・何かを指し示す。 */
  'present',
] as const;

export type AvatarGesture = (typeof AVATAR_GESTURES)[number];

/** 判断の側が「身振り無し」を選んだときのラベル。 */
export const NO_GESTURE = 'none';

/**
 * これ未満の確信度では出さない。**表情（0.6）より高い。**
 *
 * 実測では、感情を選ぶときの確信度は 0.75〜1.00 に固まっていた
 * （→ D-41 の 4）。身振りは外れの代償が大きいので、**その下端に合わせる。**
 * 迷っているなら出さないほうが、会話の見え方は良い。
 */
export const MIN_GESTURE_CONFIDENCE = 0.75;

/**
 * 続けて出すまでの最短間隔（ミリ秒）。
 *
 * **身振りは「たまに出る」から意味がある。** 毎回動くと、聞いているのでは
 * なく再生されているように見える。表情の 3 秒（→ D-41 の 3）より長いのは、
 * 身振りが体全体を使う分だけ目に付きやすいため。
 */
export const MIN_GESTURE_INTERVAL_MS = 12_000;

function isAvatarGesture(value: string): value is AvatarGesture {
  return (AVATAR_GESTURES as readonly string[]).includes(value);
}

/**
 * 判断を身振りに写す。**写せないもの・自信の無いものは「出さない」。**
 *
 * `none` を選んだときだけでなく、**語彙に無いラベルが返ったときも黙って
 * 出さない** —— 身振りは推測で代用できる種類のものではない。
 */
export function toGesture(
  label: string,
  confidence: number,
): AvatarGesture | undefined {
  if (!isAvatarGesture(label)) return undefined;
  if (confidence < MIN_GESTURE_CONFIDENCE) return undefined;
  return label;
}

/** 前回から間が空いていないので見送るか。 */
export function shouldSkipGesture(
  lastAt: number | undefined,
  now: number,
  minIntervalMs: number = MIN_GESTURE_INTERVAL_MS,
): boolean {
  if (lastAt === undefined) return false;
  return now - lastAt < minIntervalMs;
}
