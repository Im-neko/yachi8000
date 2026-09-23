import { VRM_EXPRESSION_PRESETS, type VrmExpressionPreset } from './api.ts';

/**
 * 設定 UI（F-61）が触れる範囲。**agent 側の `EditableSettings` と同じ形。**
 * パス（VRM・身振り）とチャンネル ID は入っていない（→ D-44）。
 */
export interface EditableSettings {
  identity: { name: string };
  persona: { firstPerson: string; personality: string; speechStyle: string };
  /** 設定ファイルに `avatar` 節があるときだけ来る。 */
  avatar?: {
    idleExpression: VrmExpressionPreset;
    camera: { targetHeight: number; distance: number };
  };
  voice: { speakerId: number; speedScale: number; pitchScale: number };
  notification: { whenNoOutput: 'text' | 'drop' };
  behavior: { personaLock: boolean; reminderPollIntervalSeconds: number };
}

export interface LoadedSettings {
  /** 保存するときに返す版。**手編集との衝突を見るため**（F-61）。 */
  version: string;
  settings: EditableSettings;
}

/** エンジンが持つ声。**一覧は毎回エンジンから取る**（→ D-05）。 */
export interface SpeakerStyle {
  id: number;
  label: string;
}

const SETTINGS_URL = '/api/v1/settings';

/** サーバが返した断り。文面はそのまま画面に出す。 */
export class SettingsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * **ログインが切れていないかを先に見る。**
 *
 * この経路は ingress の forward auth の内側にある（→ D-37）。セッションが
 * 切れていると、認証基盤がログイン画面へ 302 で送る —— `fetch` はそれを
 * 黙って辿るので、**HTML を掴んだまま `ok` が真になる。** そのまま
 * `json()` すると「Unexpected token '<'」が画面に出て、何が起きたのか
 * 分からなくなる。
 */
function assertSignedIn(response: Response): void {
  const json = response.headers
    .get('content-type')
    ?.includes('application/json');
  if (response.redirected || !json) {
    throw new SettingsError(
      response.status,
      'ログインが切れています。ページを読み直してください。',
    );
  }
}

async function failureOf(response: Response): Promise<SettingsError> {
  // **中身を読んでから投げる。** 「保存できません」だけだと、衝突なのか
  // 値が駄目なのかエンジンが落ちているのかが区別できない。
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') message = body.error;
  } catch {
    // 本文が JSON でない場合は状態コードだけで伝える。
  }
  return new SettingsError(response.status, message);
}

/**
 * いま自分が誰として通っているか（→ D-45）。
 *
 * **対応表（`web.speakers`）は設定ファイルに手で書く**（→ D-44）。書くには
 * 認証基盤での自分の利用者名が要るが、**それを知る手立てがどこにも無かった。**
 */
export interface Me {
  username: string | null;
  speakerId: string | null;
}

export async function fetchMe(): Promise<Me> {
  const response = await fetch(`${SETTINGS_URL.replace(/\/settings$/, '')}/me`);
  if (!response.ok) throw await failureOf(response);
  assertSignedIn(response);
  return (await response.json()) as Me;
}

export async function fetchSettings(): Promise<LoadedSettings> {
  const response = await fetch(SETTINGS_URL);
  if (!response.ok) throw await failureOf(response);
  assertSignedIn(response);
  return (await response.json()) as LoadedSettings;
}

/**
 * 選べる声を取る。**取れなければ投げる** —— 空の選択肢を出すと、
 * 「このエンジンには声が無い」ように見えてしまう。
 */
export async function fetchSpeakers(): Promise<SpeakerStyle[]> {
  const response = await fetch(`${SETTINGS_URL}/voices`);
  if (!response.ok) throw await failureOf(response);
  assertSignedIn(response);
  return ((await response.json()) as { speakers: SpeakerStyle[] }).speakers;
}

export async function saveSettings(
  loaded: LoadedSettings,
): Promise<LoadedSettings> {
  const response = await fetch(SETTINGS_URL, {
    method: 'PUT',
    // **JSON だと名乗る。** サーバはこれが無い要求を受けない（画面の外から
    // 仕込まれた form を閉じるため）。
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(loaded),
  });
  if (!response.ok) throw await failureOf(response);
  // **保存でも見る。** 切れたセッションのまま押すと、PUT が 302 で
  // ログイン画面へ流れ、**保存されていないのに成功したように見える。**
  assertSignedIn(response);
  return (await response.json()) as LoadedSettings;
}

/** 待機時の表情の選択肢。**VRM 1.0 のプリセットだけ**（→ D-36 の 1）。 */
export const EXPRESSION_LABELS: Record<VrmExpressionPreset, string> = {
  neutral: '素の顔',
  happy: 'うれしい',
  angry: 'おこる',
  sad: 'かなしい',
  relaxed: 'おだやか',
  surprised: 'おどろく',
};

export { VRM_EXPRESSION_PRESETS };
