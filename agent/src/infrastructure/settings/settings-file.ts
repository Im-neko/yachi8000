import { readFileSync, statSync } from 'node:fs';
import * as v from 'valibot';
import { parse as parseYaml } from 'yaml';
import type { SettingsProvider } from '../../domain/ports/settings-provider.ts';
import type { Settings } from '../../domain/settings.ts';
import { logger } from '../../observability/logger.ts';

const NonEmpty = v.pipe(v.string(), v.minLength(1));
const Snowflake = v.pipe(v.string(), v.regex(/^\d{17,20}$/));
/** 通知の宛先名（F-15）。送信元が本文で指定するので、形を狭く決めておく。 */
const ChannelName = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,31}$/));

const SettingsSchema = v.object({
  identity: v.object({
    name: NonEmpty,
    userAddress: NonEmpty,
  }),
  persona: v.object({
    firstPerson: NonEmpty,
    personality: NonEmpty,
    speechStyle: NonEmpty,
  }),
  voice: v.object({
    speakerId: v.pipe(v.number(), v.integer(), v.minValue(0)),
    speedScale: v.pipe(v.number(), v.minValue(0.5), v.maxValue(2)),
    pitchScale: v.pipe(v.number(), v.minValue(-0.15), v.maxValue(0.15)),
  }),
  notification: v.object({
    whenNotInVoice: v.picklist(['text', 'drop']),
    fallbackChannelId: v.optional(Snowflake),
    channels: v.optional(
      v.record(
        ChannelName,
        v.object({ guildId: Snowflake, channelId: Snowflake }),
      ),
    ),
  }),
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

/** テスト用。ファイルを経由せずに設定の妥当性だけを確かめる。 */
export function parseSettingsYaml(source: string): Settings {
  return parseSettings(source, '(inline)');
}
