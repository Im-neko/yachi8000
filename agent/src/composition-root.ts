import type { Client } from 'discord.js';
import type { MemoryDependencies } from './application/memory.ts';
import type { NotifyDependencies } from './application/notify.ts';
import type { PersonaDependencies } from './application/persona.ts';
import {
  createSpeechService,
  type SpeechService,
} from './application/speech.ts';
import type { VoiceSessionDependencies } from './application/voice-session.ts';
import { env } from './config/env.ts';
import type { SpeechSynthesizer } from './domain/ports/speech-synthesizer.ts';
import { createDiscordTextNotifier } from './infrastructure/discord/text-notifier.ts';
import { createDiscordVoiceOutput } from './infrastructure/discord/voice-output.ts';
import { createProxyEmbedder } from './infrastructure/llm/embedder.ts';
import { createNotificationRewriter } from './infrastructure/llm/notification-rewriter.ts';
import { createPgvectorMemoryStore } from './infrastructure/memory/pgvector-memory-store.ts';
import { createEmptyPersonaDiffStore } from './infrastructure/persona/empty-persona-diff-store.ts';
import { createSettingsFileProvider } from './infrastructure/settings/settings-file.ts';
import { createVoicevoxSynthesizer } from './infrastructure/voice/voicevox-synthesizer.ts';
import { logger } from './observability/logger.ts';

/**
 * 合成ルート。infrastructure の具体実装をここだけで組み立て、
 * application のユースケースには port として渡す。
 *
 * app.ts と agents/ の両方から使う。`app.ts` は起動時の配線（スキーマ準備・
 * Discord 接続）を、`agents/` は 1 ターンの組み立てを担当する。
 */

const settings = createSettingsFileProvider(env.SETTINGS_PATH);

const embedder = createProxyEmbedder({
  baseUrl: env.LLM_PROXY_BASE_URL,
  apiKey: env.LLM_PROXY_API_KEY,
});

export const memoryStore = createPgvectorMemoryStore({
  connectionString: env.MEMORY_DATABASE_URL,
  embedder,
});

export const memoryDependencies: MemoryDependencies = { store: memoryStore };

export const personaDependencies: PersonaDependencies = {
  settings,
  diffs: createEmptyPersonaDiffStore(),
};

/** 設定ファイルの現在値。表示整形（Discord 側）からも読む。 */
export const settingsProvider = settings;

export interface VoiceRuntime {
  synthesizer: SpeechSynthesizer;
  speech: SpeechService;
  voiceSession: VoiceSessionDependencies;
  notify: NotifyDependencies;
}

/**
 * 音声まわりの配線（F-11〜F-19）。
 *
 * Discord の Client に依存するので、Gateway が ready になってから
 * app.ts が呼ぶ。`speech` は 1 つだけ作る —— 発話の経路を増やすと
 * 順序が非決定になる（INV-5）。
 */
export function createVoiceRuntime(client: Client): VoiceRuntime {
  const synthesizer = createVoicevoxSynthesizer({
    baseUrl: env.VOICEVOX_URL,
    settings,
  });
  const voice = createDiscordVoiceOutput(client);
  const speech = createSpeechService({ synthesizer, voice, log: logger });

  return {
    synthesizer,
    speech,
    voiceSession: { voice, log: logger },
    notify: {
      rewriter: createNotificationRewriter({
        baseUrl: env.LLM_PROXY_BASE_URL,
        apiKey: env.LLM_PROXY_API_KEY,
        model: env.LLM_MODEL,
        settings,
      }),
      speech,
      voice,
      text: createDiscordTextNotifier(client),
      settings,
      log: logger,
    },
  };
}
