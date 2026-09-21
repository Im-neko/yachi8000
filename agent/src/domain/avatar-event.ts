import type { AvatarExpression } from './avatar.ts';
import type { VisemeTimeline } from './lipsync.ts';

/**
 * アバターへ配るイベント（F-21, F-22）。転送は SSE（→ D-38 の 1）。
 *
 * **この型は「ブラウザへ出ていく形」そのもの。** 受け手は yachi8000 の外
 * （`web/`）にあるので、フィールドを消すときは向こうも同時に直す。
 */

/**
 * 会話の状態（F-22）。強い順に `speaking` → `thinking` → `idle`。
 *
 * **`listening` はまだ無い。** 音声入力（フェーズ 7）が入るまで、
 * 「聞いている」を言える出どころがどこにも無い（→ D-38 の 3）。
 */
export type AvatarState = 'idle' | 'thinking' | 'speaking';

/** 強い順。同時に成り立つときはこの順で前のものが勝つ。 */
export const AVATAR_STATES: readonly AvatarState[] = [
  'speaking',
  'thinking',
  'idle',
];

export type AvatarEvent =
  | { readonly kind: 'state'; readonly state: AvatarState }
  /**
   * 1 文を読み上げ始める直前に出る（→ D-38 の 4）。
   *
   * `lipSync.frames` の時刻の 0 秒は、**その文の音の先頭**。ブラウザが
   * 自分でも音を鳴らしているならその再生位置、鳴らしていないなら
   * このイベントが届いた時刻になる（→ D-39 の 2）。
   */
  | {
      readonly kind: 'speech';
      readonly lipSync: VisemeTimeline;
      /**
       * 同じ音を取りに行くための ID（F-23）。**音そのものは載せない** ——
       * 重さでこの流れを塞ぐため（→ D-39 の 4）。取りに行くのが遅れて
       * 消えていることもある。
       */
      readonly speechId: string;
    }
  /**
   * 顔に出す感情（F-24）。**発話ごとに 1 回**出る（→ D-41 の 1）。
   *
   * `weight` が 0 なら素の顔へ戻す合図。口形（`speech`）とは**別の層**で、
   * どちらも同時に成り立つ（喋りながら笑う）。重ねかたはブラウザ側の
   * 規則（`web/src/stage.ts`）。
   */
  | {
      readonly kind: 'expression';
      readonly expression: AvatarExpression;
      readonly weight: number;
    };
