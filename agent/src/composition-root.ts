import type { Client } from 'discord.js';
import type { AvatarDependencies } from './application/avatar.ts';
import type { IssueDependencies } from './application/issue.ts';
import type { MemoryDependencies } from './application/memory.ts';
import type { NotifyDependencies } from './application/notify.ts';
import type { PersonDependencies } from './application/person.ts';
import type { PersonaDependencies } from './application/persona.ts';
import type {
  ReminderDeliveryDependencies,
  ReminderDependencies,
} from './application/reminder.ts';
import type { SkillDependencies } from './application/skill.ts';
import {
  createSpeechService,
  type SpeechService,
} from './application/speech.ts';
import type { VoiceSessionDependencies } from './application/voice-session.ts';
import type { WebSearchDependencies } from './application/web-search.ts';
import { env } from './config/env.ts';
import type { IssueTracker } from './domain/ports/issue-tracker.ts';
import type { SpeechSynthesizer } from './domain/ports/speech-synthesizer.ts';
import { createFileModelReader } from './infrastructure/avatar/file-model-reader.ts';
import { openAppDatabase } from './infrastructure/db/app-database.ts';
import { createDiscordMessageMarker } from './infrastructure/discord/message-marker.ts';
import { createDiscordTextNotifier } from './infrastructure/discord/text-notifier.ts';
import { createDiscordVoiceOutput } from './infrastructure/discord/voice-output.ts';
import { createGithubIssueTracker } from './infrastructure/github/github-issue-tracker.ts';
import { createProxyEmbedder } from './infrastructure/llm/embedder.ts';
import { createNotificationRewriter } from './infrastructure/llm/notification-rewriter.ts';
import { createReminderPhraser } from './infrastructure/llm/reminder-phraser.ts';
import { createPgvectorMemoryStore } from './infrastructure/memory/pgvector-memory-store.ts';
import { createSqlitePersonProfileStore } from './infrastructure/person/sqlite-person-profile-store.ts';
import { createSqlitePersonaDiffStore } from './infrastructure/persona/sqlite-persona-diff-store.ts';
import { createSqliteReminderStore } from './infrastructure/reminder/sqlite-reminder-store.ts';
import { createBraveSearcher } from './infrastructure/search/brave-search.ts';
import { createSettingsFileProvider } from './infrastructure/settings/settings-file.ts';
import { createSqliteSkillStore } from './infrastructure/skill/sqlite-skill-store.ts';
import { createVoicevoxSynthesizer } from './infrastructure/voice/voicevox-synthesizer.ts';
import { logger } from './observability/logger.ts';

/**
 * 合成ルート。infrastructure の具体実装をここだけで組み立て、
 * application のユースケースには port として渡す。
 *
 * app.ts と agents/ の両方から使う。`app.ts` は起動時の配線（スキーマ準備・
 * Discord 接続・poller）を、`agents/` は 1 ターンの組み立てを担当する。
 */

const settings = createSettingsFileProvider(env.SETTINGS_PATH);

/**
 * ランタイム状態の SQLite（→ D-24）。**Flue の会話履歴 DB とは別ファイル。**
 * 会話履歴は Flue がスキーマごと所有している（永続化一覧の #1）。
 */
const appDb = openAppDatabase(env.APP_DB_PATH);

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
  diffs: createSqlitePersonaDiffStore(appDb),
  log: logger,
};

/** 話しかけてくる相手のプロフィール（F-05）。 */
export const personDependencies: PersonDependencies = {
  store: createSqlitePersonProfileStore(appDb),
  log: logger,
};

export const skillDependencies: SkillDependencies = {
  store: createSqliteSkillStore(appDb),
  settings,
  log: logger,
};

const reminderStore = createSqliteReminderStore(appDb);

/** ツールが使う側（登録・一覧・削除）。配信は poller 側の配線で足す。 */
export const reminderDependencies: ReminderDependencies = {
  store: reminderStore,
};

export const webSearchDependencies: WebSearchDependencies = {
  searcher: createBraveSearcher({ apiKey: env.BRAVE_SEARCH_API_KEY }),
};

/**
 * 起票先が無い環境でも起動はできるようにする。**代わりに黙って成功しない**
 * —— 呼ばれた時点で「トークンが無い」と名指しで投げ、その文面が利用者まで届く。
 * 起票は常時動いている必要がある機能ではないので、起動を止める理由にはしない。
 */
function createIssueTrackerFromEnv(): IssueTracker {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    return {
      create() {
        throw new Error(
          'GITHUB_TOKEN が設定されていないため Issue を立てられません。運用者に設定を頼んでください。',
        );
      },
    };
  }
  return createGithubIssueTracker({ token });
}

/** チャットの投稿を Issue にする経路（F-37）。 */
export const issueDependencies: IssueDependencies = {
  tracker: createIssueTrackerFromEnv(),
  settings,
  marker: createDiscordMessageMarker({ token: env.DISCORD_BOT_TOKEN }),
  log: logger,
};

/** アバターの表示（F-20）。VRM は設定ファイルが指す 1 ファイル（→ D-36 の 2）。 */
export const avatarDependencies: AvatarDependencies = {
  settings,
  models: createFileModelReader(),
  log: logger,
};

/** 設定ファイルの現在値。表示整形（Discord 側）からも読む。 */
export const settingsProvider = settings;

export interface VoiceRuntime {
  synthesizer: SpeechSynthesizer;
  speech: SpeechService;
  voiceSession: VoiceSessionDependencies;
  notify: NotifyDependencies;
  /** リマインダーの発火（F-31）。VC と Discord の Client に依存する。 */
  reminder: ReminderDeliveryDependencies;
}

/**
 * 音声まわりの配線（F-11〜F-19）とリマインダーの配信（F-31）。
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
  const text = createDiscordTextNotifier(client);

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
      text,
      settings,
      log: logger,
    },
    reminder: {
      store: reminderStore,
      phraser: createReminderPhraser({
        baseUrl: env.LLM_PROXY_BASE_URL,
        apiKey: env.LLM_PROXY_API_KEY,
        model: env.LLM_MODEL,
        settings,
      }),
      speech,
      voice,
      text,
      log: logger,
    },
  };
}
