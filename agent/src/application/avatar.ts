import {
  type AvatarView,
  avatarModelPathOf,
  avatarViewOf,
} from '../domain/avatar.ts';
import type { ModelFileReader } from '../domain/ports/model-file-reader.ts';
import type { SettingsProvider } from '../domain/ports/settings-provider.ts';

export interface AvatarDependencies {
  settings: SettingsProvider;
  models: ModelFileReader;
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
