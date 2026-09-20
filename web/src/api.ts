/** VRM 1.0 の標準プリセット表情（→ D-36 の 1）。モデル固有名は使わない。 */
export const VRM_EXPRESSION_PRESETS = [
  'neutral',
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
] as const;

export type VrmExpressionPreset = (typeof VRM_EXPRESSION_PRESETS)[number];

export interface AvatarConfig {
  /** 待機時の表情。プリセット名だけが来る（agent 側の設定スキーマで検証済み）。 */
  idleExpression: VrmExpressionPreset;
  camera: {
    /** 注視点の高さ（m）。モデルの身長に合わせる。 */
    targetHeight: number;
    /** 注視点からの距離（m）。 */
    distance: number;
  };
}

/** VRM 本体。agent が設定ファイルの指す 1 ファイルを返す（→ D-36 の 2）。 */
export const AVATAR_MODEL_URL = '/api/v1/avatar/model';

/**
 * アバターの表示設定を取る。
 *
 * **失敗したら投げる。** 既定値で代用すると、設定を書き換えたのに反映され
 * ないことに気付けない（フォールバック禁止）。
 */
export async function fetchAvatarConfig(): Promise<AvatarConfig> {
  const response = await fetch('/api/v1/avatar/config');
  if (!response.ok) {
    throw new Error(
      `アバターの設定を取得できませんでした（HTTP ${response.status}）。`,
    );
  }
  return (await response.json()) as AvatarConfig;
}
