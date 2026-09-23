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

/**
 * 出せる身振り（F-25）。**種類は agent 側の語彙と同じ順・同じ名前。**
 * 実体（VRMA）は運用者が置いたものだけが配られる。
 */
export const AVATAR_GESTURES = [
  'nod',
  'tilt',
  'wave',
  'bow',
  'shrug',
  'present',
] as const;

export type AvatarGesture = (typeof AVATAR_GESTURES)[number];

export interface AvatarConfig {
  /** 待機時の表情。プリセット名だけが来る（agent 側の設定スキーマで検証済み）。 */
  idleExpression: VrmExpressionPreset;
  camera: {
    /** 注視点の高さ（m）。モデルの身長に合わせる。 */
    targetHeight: number;
    /** 注視点からの距離（m）。 */
    distance: number;
  };
  /** **素材が置いてある身振りだけ**が入る。空なら身振りは出ない。 */
  gestures: AvatarGesture[];
  /** 素材の出どころ表記。**クレジットを求めるライセンスがあるため**（→ D-42 の 2）。 */
  attribution?: string;
}

/** VRM 本体。agent が設定ファイルの指す 1 ファイルを返す（→ D-36 の 2）。 */
export const AVATAR_MODEL_URL = '/api/v1/avatar/model';

/**
 * 身振りの素材（F-25）。**種類しか渡さない** —— パスを渡せる作りにすると、
 * 表示のために開けた口がファイルシステムの覗き穴になる（→ D-36 の 2）。
 */
export function gestureMotionUrl(gesture: AvatarGesture): string {
  return `/api/v1/avatar/gesture?kind=${encodeURIComponent(gesture)}`;
}

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
  | { kind: 'speech'; lipSync: VisemeTimeline; speechId: string }
  /**
   * 顔に出す感情（F-24）。**発話ごとに 1 回**来て、読み終わると
   * `weight: 0`（素の顔）が来る。口形とは別の層で、同時に成り立つ。
   */
  | { kind: 'expression'; expression: VrmExpressionPreset; weight: number }
  /**
   * 身振り（F-25）。**出るときだけ来る**（大半の発話では来ない）。
   * 1 回再生して待機へ戻す。
   */
  | { kind: 'gesture'; gesture: AvatarGesture };

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

  // **イベント名ごとに登録する。** SSE は `event:` 名で振り分けるので、
  // ここに無い種別は届いても黙って捨てられる（`AvatarEvent` に足すだけでは
  // 通らない）。
  source.addEventListener('state', handle);
  source.addEventListener('speech', handle);
  source.addEventListener('expression', handle);
  source.addEventListener('gesture', handle);
  source.addEventListener('open', () => onConnectionChange?.(true));
  source.addEventListener('error', () => onConnectionChange?.(false));

  return () => source.close();
}

/**
 * 話しかけた結果（F-13 の経路 B、→ D-47）。
 *
 * **`heard: false` は失敗ではない。** 文字起こしのエンジンは 2 秒に満たない
 * 発話へ、エラーではなく空文字を返す（→ D-16 の追記の 3）。
 */
export interface UtteranceResult {
  heard: boolean;
  transcript: string | null;
  reply: string | null;
}

/**
 * 話しかけが断られた。
 *
 * **枠切れかどうかを持つ**（→ Q-29）。枠切れは**待っても直らない**ので、
 * 一度出たら出しっぱなしにしてよい理由がここにある。
 */
export class UtteranceRejected extends Error {
  constructor(
    message: string,
    readonly rateLimited: boolean,
  ) {
    super(message);
    this.name = 'UtteranceRejected';
  }
}

/**
 * 録った 1 発話を送る。
 *
 * **失敗したら投げる。** 黙って何も起きないのが音声入力の最悪の壊れ方で、
 * 利用者から見て「聞こえていない」のか「無視された」のかが区別できない。
 */
export async function sendUtterance(
  blob: Blob,
  contentType: string,
): Promise<UtteranceResult> {
  const response = await fetch('/api/v1/mic/utterance', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: blob,
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // JSON でなければ状態コードだけで伝える。
    }
    throw new UtteranceRejected(message, response.status === 429);
  }
  return (await response.json()) as UtteranceResult;
}

/** カメラの前に人がいるか（F-26、→ D-46）。**映像は送らない。** */
export type Presence = 'present' | 'absent' | 'unknown';

/**
 * いまの状態をサーバへ伝える。
 *
 * **失敗しても投げない。** これが届かなくても、いちばん困るのは
 * 「読み上げが止まらない」ことで、それは今までどおりの振る舞い（→ D-46 の 2
 * で `unknown` を「今までどおり」に倒した理由と同じ）。**カメラが理由で
 * 会話そのものが止まってはいけない。**
 */
export async function reportPresence(state: Presence): Promise<void> {
  try {
    await fetch('/api/v1/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state }),
    });
  } catch {
    // 次の報告で追いつく。
  }
}
