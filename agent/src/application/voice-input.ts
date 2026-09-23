import type { SettingsProvider } from '../domain/ports/settings-provider.ts';
import {
  type RecordedUtterance,
  type Transcriber,
  TranscriptionFailure,
} from '../domain/ports/transcriber.ts';
import { parseDiscordUserSpeaker, type SpeakerId } from '../domain/speaker.ts';

export interface VoiceInputDependencies {
  /** 対応表を読む（→ D-45）。書かない。 */
  settings: SettingsProvider;
  /**
   * 文字起こし（→ D-16）。**任意** —— `STT_MODEL` を渡していなければ
   * 音声入力だけが使えず、会話は普通に動く。
   */
  transcriber?: Transcriber;
  log: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
  };
}

/** 対応表で引いた話者。 */
export interface WebSpeaker {
  readonly speakerId: SpeakerId;
  /** Discord のユーザー ID。会話の宛先を組み立てるのに使う。 */
  readonly userId: string;
}

/**
 * 認証基盤の利用者名から話者を引く（→ D-45）。
 *
 * **対応表に無ければ undefined。** 「誰か分からない人」として記憶に書き
 * 込むのではなく、操作そのものを断る —— 帰属の曖昧な長期記憶とリマインダーは
 * あとから選り分けられない。
 */
export function resolveWebSpeaker(
  deps: VoiceInputDependencies,
  username: string | undefined,
): WebSpeaker | undefined {
  if (!username) return undefined;
  const configured = deps.settings.get().web?.speakers[username];
  if (!configured) return undefined;

  const speaker = parseDiscordUserSpeaker(configured);
  if (!speaker) {
    // スキーマで形は検査しているので、ここへ来るのは設定を書き換えた直後の
    // 一瞬だけ。**黙って通さない。**
    deps.log.warn(
      { username },
      'The speaker mapping has an unusable value — ignoring it',
    );
    return undefined;
  }
  return speaker;
}

/** 文字起こしの結果。**「聞き取れなかった」は失敗ではない。** */
export type TranscriptionOutcome =
  | { kind: 'heard'; text: string }
  /**
   * 空で返った（→ D-16 の追記の 3）。エンジンは 2 秒に満たない発話へ
   * エラーではなく空文字を返す。**普通に起こる。**
   */
  | { kind: 'not-heard' }
  /** 文字起こしが設定されていない（`STT_MODEL` が無い）。 */
  | { kind: 'not-configured' }
  /**
   * 利用枠を使い切った（→ Q-29）。**数秒待っても直らない**ので、
   * 「落ちている」とは別に扱う。
   */
  | { kind: 'rate-limited'; message: string }
  /** エンジンが落ちている・時間切れ（→ Q-29）。 */
  | { kind: 'unavailable'; message: string };

/**
 * 発話を文字にする（F-13）。
 *
 * **落ちても投げない。** 音声入力の最悪の壊れ方は「話しかけたのに無言」で、
 * 利用者から見て原因が何も分からないこと。どの経路でも**必ずログに残し**、
 * 呼び出し側が画面に出せる形で返す（→ INV-7）。
 */
export async function transcribeUtterance(
  deps: VoiceInputDependencies,
  utterance: RecordedUtterance,
): Promise<TranscriptionOutcome> {
  if (!deps.transcriber) return { kind: 'not-configured' };

  let text: string;
  try {
    text = await deps.transcriber.transcribe(utterance);
  } catch (error) {
    const rateLimited =
      error instanceof TranscriptionFailure && error.reason === 'rate-limited';
    deps.log.warn(
      { err: error, bytes: utterance.bytes.length, rateLimited },
      'Could not transcribe the utterance',
    );
    const message = (error as Error).message;
    return rateLimited
      ? { kind: 'rate-limited', message }
      : { kind: 'unavailable', message };
  }

  if (text === '') {
    deps.log.info(
      { bytes: utterance.bytes.length, contentType: utterance.contentType },
      'Heard nothing in the utterance',
    );
    return { kind: 'not-heard' };
  }
  return { kind: 'heard', text };
}
