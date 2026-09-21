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

/**
 * 発話と会話状態の流れ（F-21, F-22）。**SSE**（→ D-38 の 1）。
 *
 * WebSocket ではないのは Flue の起動経路が Node の http サーバを返さないため。
 * 一方向で足りるので、再接続が付いてくる `EventSource` のほうが噛み合う。
 */
export const AVATAR_EVENTS_URL = '/api/v1/avatar/events';

/** 会話の状態。`listening` は音声入力（フェーズ 7）が入るまで来ない。 */
export type AvatarState = 'idle' | 'thinking' | 'speaking';

/** 口形。`sil` は「口を閉じる」。 */
export type Viseme = 'aa' | 'ih' | 'ou' | 'ee' | 'oh' | 'sil';

export interface VisemeFrame {
  /** 発話の先頭からの秒数。 */
  at: number;
  viseme: Viseme;
}

export interface VisemeTimeline {
  frames: VisemeFrame[];
  duration: number;
}

export type AvatarEvent =
  | { kind: 'state'; state: AvatarState }
  | { kind: 'speech'; lipSync: VisemeTimeline; speechId: string };

/**
 * 読み上げた音（F-23）。**イベントには ID だけが載る**ので、鳴らすなら
 * ここから取りに行く（→ D-39 の 4）。溜まっているのは直近だけで、
 * 遅れると 404 になる。
 */
export function speechAudioUrl(speechId: string): string {
  return `/api/v1/avatar/speech?id=${encodeURIComponent(speechId)}`;
}

/**
 * イベントを購読する。戻り値を呼ぶとやめる。
 *
 * **再接続は `EventSource` に任せる。** 切れている間に来た発話は落ちるが、
 * 過ぎた口を後から動かしても意味がないので取りに行かない。
 */
export interface SubscribeOptions {
  /**
   * **このタブが音を鳴らせるか**（F-23, D-40）。
   *
   * サーバはこれを「出口がひとつある」と数える。既定は消音なので、
   * 押されていないタブが出口として数えられると、**通知が無音へ向かって
   * 「喋った」ことになり、テキストへの退避も止まる**。
   * 「音を出す」を押したら、この値を変えて**つなぎ直す**。
   */
  audio: boolean;
  onConnectionChange?: (connected: boolean) => void;
}

export function subscribeAvatarEvents(
  onEvent: (event: AvatarEvent) => void,
  options: SubscribeOptions,
): () => void {
  const { audio, onConnectionChange } = options;
  const source = new EventSource(
    audio ? `${AVATAR_EVENTS_URL}?audio=1` : AVATAR_EVENTS_URL,
  );

  const handle = (raw: MessageEvent<string>) => {
    try {
      onEvent(JSON.parse(raw.data) as AvatarEvent);
    } catch {
      // 壊れた 1 通で購読ごと落とさない。次のイベントは普通に届く。
    }
  };

  source.addEventListener('state', handle);
  source.addEventListener('speech', handle);
  source.addEventListener('open', () => onConnectionChange?.(true));
  source.addEventListener('error', () => onConnectionChange?.(false));

  return () => source.close();
}
