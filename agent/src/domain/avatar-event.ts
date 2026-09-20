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
   * 1 文を読み上げ始める直前に出る（→ D-38 の 4）。`lipSync.frames` の
   * 時刻は**このイベントを受け取った時点からの相対**。
   */
  | { readonly kind: 'speech'; readonly lipSync: VisemeTimeline };
