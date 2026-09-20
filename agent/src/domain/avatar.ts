import type { Settings } from './settings.ts';

/**
 * 使ってよい表情（→ D-36 の 1）。**VRM 1.0 の標準プリセットだけ。**
 *
 * モデル固有の blendshape 名（`Face_Blendshape.Fcl_MTH_A` のようなもの）は
 * three-vrm の `expressionManager` がプリセット名の裏に隠すので、こちら側で
 * 対応表を持たない。プリセットに無い表情が要るとなった時点で改めて決める。
 *
 * 口形（`aa` `ih` `ou` `ee` `oh`）と視線は発話に合わせて動かすもの（F-21）
 * なので、人が設定ファイルで選ぶ対象からは外してある。
 */
export const AVATAR_EXPRESSIONS = [
  'neutral',
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
] as const;

export type AvatarExpression = (typeof AVATAR_EXPRESSIONS)[number];

/** ブラウザへ渡す表示設定（F-20）。VRM 本体は別の経路で配る。 */
export interface AvatarView {
  idleExpression: AvatarExpression;
  camera: {
    /** 注視点の高さ（m）。モデルの身長に合わせる。 */
    targetHeight: number;
    /** 注視点からの距離（m）。 */
    distance: number;
  };
}

/**
 * 設定ファイルから表示設定を取り出す。
 *
 * **アバターは任意**（→ F-20）。設定が無ければ undefined を返す ——
 * フェーズ 5 までの利用者は `avatar` を書いていないので、必須にすると
 * 起動が止まる。
 */
export function avatarViewOf(settings: Settings): AvatarView | undefined {
  const avatar = settings.avatar;
  if (!avatar) return undefined;
  return {
    idleExpression: avatar.idleExpression,
    camera: { ...avatar.camera },
  };
}

/** VRM 本体の置き場所。設定が無ければ undefined。 */
export function avatarModelPathOf(settings: Settings): string | undefined {
  return settings.avatar?.vrmPath;
}
