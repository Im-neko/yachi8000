import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { parseDocument, parse as parseYaml } from 'yaml';
import { AVATAR_EXPRESSIONS } from '../../domain/avatar.ts';
import { AVATAR_GESTURES } from '../../domain/gesture.ts';
import type {
  SettingsEditor,
  SettingsSaveResult,
} from '../../domain/ports/settings-editor.ts';
import type { SettingsProvider } from '../../domain/ports/settings-provider.ts';
import {
  type EditableSettings,
  editableOf,
  type Settings,
} from '../../domain/settings.ts';
import { logger } from '../../observability/logger.ts';

const NonEmpty = v.pipe(v.string(), v.minLength(1));
const Snowflake = v.pipe(v.string(), v.regex(/^\d{17,20}$/));
/** 通知の宛先名（F-15）。送信元が本文で指定するので、形を狭く決めておく。 */
const ChannelName = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,31}$/));

const SettingsSchema = v.object({
  identity: v.object({
    name: NonEmpty,
  }),
  persona: v.object({
    firstPerson: NonEmpty,
    personality: NonEmpty,
    speechStyle: NonEmpty,
  }),
  // 表情はプリセット名だけを受ける（→ D-36 の 1）。モデル固有名を書かれても
  // three-vrm 側で解決できないので、設定の時点で落とす。
  avatar: v.optional(
    v.object({
      vrmPath: NonEmpty,
      idleExpression: v.picklist(AVATAR_EXPRESSIONS),
      camera: v.object({
        targetHeight: v.pipe(v.number(), v.minValue(0), v.maxValue(5)),
        distance: v.pipe(v.number(), v.minValue(0.1), v.maxValue(20)),
      }),
      // 身振りも種類は固定（→ D-42 の 1）。知らない名前は設定の時点で落とす
      // —— 置いたつもりで一生出ない素材が生まれるのを防ぐ。
      gestures: v.optional(
        v.partial(
          v.object(
            Object.fromEntries(
              AVATAR_GESTURES.map((gesture) => [gesture, NonEmpty]),
            ) as Record<(typeof AVATAR_GESTURES)[number], typeof NonEmpty>,
          ),
        ),
      ),
      attribution: v.optional(NonEmpty),
    }),
  ),
  voice: v.object({
    speakerId: v.pipe(v.number(), v.integer(), v.minValue(0)),
    speedScale: v.pipe(v.number(), v.minValue(0.5), v.maxValue(2)),
    pitchScale: v.pipe(v.number(), v.minValue(-0.15), v.maxValue(0.15)),
  }),
  notification: v.object({
    whenNoOutput: v.picklist(['text', 'drop']),
    fallbackChannelId: v.optional(Snowflake),
    channels: v.optional(
      v.record(
        ChannelName,
        v.object({ guildId: Snowflake, channelId: Snowflake }),
      ),
    ),
  }),
  // 認証基盤の利用者名 → 話者 ID（→ D-45）。**値の形を狭く決める** ——
  // 綴り違いを黙って通すと、帰属の間違った記憶が溜まる。
  web: v.optional(
    v.object({
      speakers: v.record(
        NonEmpty,
        v.pipe(v.string(), v.regex(/^discord-user-\d+$/)),
      ),
    }),
  ),
  issueTracker: v.optional(
    v.object({
      repositories: v.record(
        v.pipe(v.string(), v.regex(/^\d{17,20}$/)),
        v.pipe(v.string(), v.regex(/^[\w.-]+\/[\w.-]+$/)),
      ),
    }),
  ),
  behavior: v.object({
    personaLock: v.boolean(),
    reminderPollIntervalSeconds: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(5),
      v.maxValue(3600),
    ),
  }),
});

function parseSettings(source: string, path: string): Settings {
  const result = v.safeParse(SettingsSchema, parseYaml(source));
  if (!result.success) {
    throw new Error(
      `設定ファイル ${path} の検証に失敗しました:\n${v.summarize(result.issues)}`,
    );
  }
  return result.output;
}

/**
 * 設定ファイル（F-60）を読む。
 *
 * 設定 UI（F-61）が動いている間に書き換わるので、起動時に 1 度読んで
 * 固定しない。毎回 stat して mtime が変わったときだけ読み直す。
 *
 * **この経路は読むだけ。** 設定ファイルへ書いてよいのは人の操作を契機と
 * するハンドラだけで、会話ロジックは書かない（INV-9）。
 */
export function createSettingsFileProvider(path: string): SettingsProvider {
  let cached: { mtimeMs: number; settings: Settings } | undefined;

  function read(): Settings {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch (error) {
      throw new Error(
        `設定ファイル ${path} を読めません。settings.example.yaml を複製して SETTINGS_PATH の場所に置いてください。(${(error as Error).message})`,
      );
    }
    if (cached && cached.mtimeMs === mtimeMs) return cached.settings;

    const settings = parseSettings(readFileSync(path, 'utf8'), path);
    if (cached) {
      logger.info({ path }, 'Reloaded settings file');
    }
    cached = { mtimeMs, settings };
    return settings;
  }

  // 起動時に 1 度読んで、壊れた設定のまま動き出さないようにする。
  read();

  return { get: read };
}

/**
 * 書き換える場所。**ここに並んでいない場所は触らない** —— 設定ファイルには
 * UI が知らない節（`notification.channels`・`issueTracker`）があり、
 * 全体を書き直すと知らないものが消える。
 */
const EDITABLE_PATHS = [
  { path: ['identity', 'name'], of: (s: EditableSettings) => s.identity.name },
  {
    path: ['persona', 'firstPerson'],
    of: (s: EditableSettings) => s.persona.firstPerson,
  },
  {
    path: ['persona', 'personality'],
    of: (s: EditableSettings) => s.persona.personality,
  },
  {
    path: ['persona', 'speechStyle'],
    of: (s: EditableSettings) => s.persona.speechStyle,
  },
  {
    path: ['voice', 'speakerId'],
    of: (s: EditableSettings) => s.voice.speakerId,
  },
  {
    path: ['voice', 'speedScale'],
    of: (s: EditableSettings) => s.voice.speedScale,
  },
  {
    path: ['voice', 'pitchScale'],
    of: (s: EditableSettings) => s.voice.pitchScale,
  },
  {
    path: ['notification', 'whenNoOutput'],
    of: (s: EditableSettings) => s.notification.whenNoOutput,
  },
  {
    path: ['behavior', 'personaLock'],
    of: (s: EditableSettings) => s.behavior.personaLock,
  },
  {
    path: ['behavior', 'reminderPollIntervalSeconds'],
    of: (s: EditableSettings) => s.behavior.reminderPollIntervalSeconds,
  },
] as const;

/** `avatar` 節がある設定にだけ書ける場所。 */
const EDITABLE_AVATAR_PATHS = [
  {
    path: ['avatar', 'idleExpression'],
    of: (a: NonNullable<EditableSettings['avatar']>) => a.idleExpression,
  },
  {
    path: ['avatar', 'camera', 'targetHeight'],
    of: (a: NonNullable<EditableSettings['avatar']>) => a.camera.targetHeight,
  },
  {
    path: ['avatar', 'camera', 'distance'],
    of: (a: NonNullable<EditableSettings['avatar']>) => a.camera.distance,
  },
] as const;

/**
 * 設定ファイルを書き換える（F-61）。
 *
 * **YAML の文書として読み、決まった場所だけを差し替える。** `parse` →
 * `stringify` で往復させると**コメントが全部消える** —— このファイルは人が
 * 手で編集するもので、何をどう書くかの説明はコメントにしか無い。設定 UI が
 * 一度保存しただけで手編集が成り立たなくなるのは、F-61 の「同じものを別の
 * 入口から触る」に反する。
 */
export function createSettingsFileEditor(path: string): SettingsEditor {
  function versionOf(): string {
    return String(statSync(path).mtimeMs);
  }

  function read(): { version: string; settings: EditableSettings } {
    // **版を先に取る。** 読んだ後に取ると、読んでから stat するまでの間の
    // 書き込みを「自分が読んだもの」として配ってしまう。
    const version = versionOf();
    return {
      version,
      settings: editableOf(parseSettings(readFileSync(path, 'utf8'), path)),
    };
  }

  return {
    read,

    save(version, next): SettingsSaveResult {
      // ここから return まで await を挟まない。挟むと「読み直し → 検証 →
      // 保存」の間に別のリクエストが割り込める（→ port のコメント）。
      if (versionOf() !== version) return { kind: 'conflict' };

      const document = parseDocument(readFileSync(path, 'utf8'));
      if (next.avatar && !document.has('avatar')) {
        return { kind: 'avatar-not-configured' };
      }

      for (const field of EDITABLE_PATHS) {
        document.setIn(field.path, field.of(next));
      }
      if (next.avatar) {
        for (const field of EDITABLE_AVATAR_PATHS) {
          document.setIn(field.path, field.of(next.avatar));
        }
      }

      // **改行で折り返させない。** 既定（80 桁）だと人格の説明のような長い
      // 行が勝手に折られ、手で書いた形と違うものが返る。
      const serialized = document.toString({ lineWidth: 0 });

      // **書く前に、書いたものをもう一度通す。** 型は通っても設定として
      // 成立しない値（範囲外の話速など）はここで落ちる。
      try {
        parseSettings(serialized, path);
      } catch (error) {
        return { kind: 'invalid', message: (error as Error).message };
      }

      // **同じディレクトリへ書いてから rename する。** 読む側は mtime の
      // 変化で読み直すので、途中まで書けたファイルを読ませない。
      const temporary = join(dirname(path), `.settings-${process.pid}.tmp`);
      writeFileSync(temporary, serialized, 'utf8');
      renameSync(temporary, path);

      const saved = read();
      logger.info({ path }, 'Saved the settings file');
      return {
        kind: 'saved',
        version: saved.version,
        settings: saved.settings,
      };
    },
  };
}

/** テスト用。ファイルを経由せずに設定の妥当性だけを確かめる。 */
export function parseSettingsYaml(source: string): Settings {
  return parseSettings(source, '(inline)');
}
