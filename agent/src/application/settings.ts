import type {
  SettingsEditor,
  SettingsSaveResult,
} from '../domain/ports/settings-editor.ts';
import type {
  SpeakerStyle,
  SpeechSynthesizer,
} from '../domain/ports/speech-synthesizer.ts';
import type { EditableSettings } from '../domain/settings.ts';

export interface SettingsEditDependencies {
  /** **書く口はここだけ**（→ D-44）。会話側には渡さない。 */
  editor: SettingsEditor;
  /** 声の選択肢を取るために使う。合成そのものはしない。 */
  synthesizer: SpeechSynthesizer;
  log: {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
  };
}

/** 保存の結果。port の結果に「声が無い」を足したもの。 */
export type SettingsUpdateResult =
  | SettingsSaveResult
  /** 選ばれた話者 ID がエンジンに無い。**保存はしていない。** */
  | { kind: 'unknown-speaker'; speakerId: number }
  /** エンジンに声を確かめられなかったので、話者の変更を保存しなかった。 */
  | { kind: 'speakers-unavailable'; message: string };

export function readEditableSettings(deps: SettingsEditDependencies): {
  version: string;
  settings: EditableSettings;
} {
  return deps.editor.read();
}

/**
 * 選べる声の一覧（F-61）。**取れなければ投げる。**
 *
 * 空の一覧を返すと「このエンジンには声が無い」に見えてしまう。エンジンに
 * 繋がらないことと、声が無いことは別のできごと。
 */
export function listVoices(
  deps: SettingsEditDependencies,
): Promise<readonly SpeakerStyle[]> {
  return deps.synthesizer.listSpeakers();
}

/**
 * 設定を書き換える（F-61）。
 *
 * **話者 ID だけは保存の前にエンジンへ確かめる。** 設定ファイルの検証は
 * 「整数かどうか」までしか見られず、実在の確認は起動時の契約検証（D-05）に
 * 委ねてある —— 画面から数字を入れられるようにすると、**動いているプロセス
 * が次に喋ろうとして初めて失敗する**穴が空く。
 *
 * **確かめるのは変わったときだけ。** 毎回問い合わせると、エンジンが落ちて
 * いる間は人格や固定モードの変更まで保存できなくなる（声とは関係がない）。
 */
export async function updateEditableSettings(
  deps: SettingsEditDependencies,
  input: {
    version: string;
    settings: EditableSettings;
    /** 誰の操作か。**ログのためだけに使う** —— 権限の判断には使わない。 */
    changedBy: string | undefined;
  },
): Promise<SettingsUpdateResult> {
  const current = deps.editor.read();
  const nextSpeaker = input.settings.voice.speakerId;

  if (nextSpeaker !== current.settings.voice.speakerId) {
    let speakers: readonly SpeakerStyle[];
    try {
      speakers = await deps.synthesizer.listSpeakers();
    } catch (error) {
      deps.log.warn(
        { err: error, speakerId: nextSpeaker },
        'Could not verify the speaker — the settings were not saved',
      );
      return {
        kind: 'speakers-unavailable',
        message: (error as Error).message,
      };
    }
    if (!speakers.some((speaker) => speaker.id === nextSpeaker)) {
      return { kind: 'unknown-speaker', speakerId: nextSpeaker };
    }
  }

  const result = deps.editor.save(input.version, input.settings);
  if (result.kind === 'saved') {
    // **誰がいつ変えたかを残す。** 設定は全体でひとつ（→ D-35）なので、
    // 踏んだ人の操作が全員に効く。スキルの承認（D-43）と同じ理由。
    deps.log.info(
      { changedBy: input.changedBy, version: result.version },
      'Updated the settings from the settings UI',
    );
  } else {
    deps.log.warn({ outcome: result.kind }, 'Rejected a settings update');
  }
  return result;
}
