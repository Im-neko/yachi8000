import {
  type AvatarView,
  avatarModelPathOf,
  avatarViewOf,
} from '../domain/avatar.ts';
import type { AvatarEvent } from '../domain/avatar-event.ts';
import type {
  AvatarEventSource,
  SubscribeOptions,
} from '../domain/ports/avatar-event-publisher.ts';
import type { ModelFileReader } from '../domain/ports/model-file-reader.ts';
import type { SettingsProvider } from '../domain/ports/settings-provider.ts';
import type { SpeechAudioStore } from '../domain/ports/speech-audio-store.ts';
import { wavFromPcm } from '../domain/speech-audio.ts';

export interface AvatarDependencies {
  settings: SettingsProvider;
  models: ModelFileReader;
  /** 発話と会話状態の流れ（F-21, F-22）。 */
  events: AvatarEventSource;
  /** ブラウザで鳴らす音の置き場（F-23）。 */
  audio: SpeechAudioStore;
  log: {
    warn(context: Record<string, unknown>, message: string): void;
  };
}

/**
 * VRM を取り出した結果。
 *
 * **「設定が無い」と「置かれていない」を分ける。** どちらも画面には何も
 * 出ないが、直し方が違う —— 前者は設定ファイルに書く、後者はファイルを
 * 置く。ひとまとめにすると利用者がどちらか分からない。
 */
export type AvatarModelResult =
  | { kind: 'ok'; bytes: Uint8Array }
  | { kind: 'not-configured' }
  | { kind: 'missing' };

/** ブラウザへ渡す表示設定（F-20）。設定が無ければ undefined。 */
export function avatarView(deps: AvatarDependencies): AvatarView | undefined {
  return avatarViewOf(deps.settings.get());
}

/**
 * VRM 本体を読む（F-20, F-62）。
 *
 * 読むのは**設定ファイルが指す 1 ファイルだけ**。リクエストからパスを
 * 受け取らないので、辿れる先が増えない（→ D-36 の 2）。
 */
export async function avatarModel(
  deps: AvatarDependencies,
): Promise<AvatarModelResult> {
  const path = avatarModelPathOf(deps.settings.get());
  if (path === undefined) return { kind: 'not-configured' };

  const bytes = await deps.models.read(path);
  if (bytes === undefined) {
    // パスはログにだけ出す。応答に載せると、置き場所をページの読み手へ
    // そのまま教えることになる。
    deps.log.warn({ path }, 'The configured VRM file is not there');
    return { kind: 'missing' };
  }
  return { kind: 'ok', bytes };
}

/**
 * 発話と会話状態を購読する（F-21, F-22）。戻り値を呼ぶと購読をやめる。
 *
 * 配り方（SSE）は interfaces 側の関心なので、ここには出てこない（→ D-38 の 1）。
 */
export function subscribeAvatarEvents(
  deps: AvatarDependencies,
  listener: (event: AvatarEvent) => void,
  options: SubscribeOptions,
): () => void {
  return deps.events.subscribe(listener, options);
}

/**
 * ブラウザで鳴らす音を取り出す（F-23）。
 *
 * **消えていることは普通に起こる**（→ D-39 の 5）。溜めているのは直近だけで、
 * 取りに来るのが遅れれば古いものから捨てられている。**そのときは鳴らさず
 * 口だけ動く**ので、気付く手がかりはログしかない（INV-7）。
 */
export function avatarSpeechAudio(
  deps: AvatarDependencies,
  speechId: string,
): Uint8Array | undefined {
  const pcm = deps.audio.get(speechId);
  if (!pcm) {
    deps.log.warn(
      { speechId },
      'The requested speech audio is already gone — the browser will stay silent for it',
    );
    return undefined;
  }
  // Discord へは PCM のまま渡している。ヘッダを付けるのはブラウザ側だけ。
  return wavFromPcm(pcm);
}
