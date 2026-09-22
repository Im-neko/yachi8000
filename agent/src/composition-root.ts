import type { Client } from 'discord.js';
import type { AvatarDependencies } from './application/avatar.ts';
import {
  type AvatarPresence,
  createAvatarPresence,
} from './application/avatar-presence.ts';
import type { IssueDependencies } from './application/issue.ts';
import type { MemoryDependencies } from './application/memory.ts';
import type { NotifyDependencies } from './application/notify.ts';
import type { PersonDependencies } from './application/person.ts';
import type { PersonaDependencies } from './application/persona.ts';
import {
  createReactionService,
  type ReactionService,
} from './application/reaction.ts';
import type {
  ReminderDeliveryDependencies,
  ReminderDependencies,
} from './application/reminder.ts';
import type { SettingsEditDependencies } from './application/settings.ts';
import type { SkillDependencies } from './application/skill.ts';
import {
  createSpeechService,
  type SpeechService,
} from './application/speech.ts';
import type { VoiceSessionDependencies } from './application/voice-session.ts';
import type { WebSearchDependencies } from './application/web-search.ts';
import { env } from './config/env.ts';
import { configuredGestures } from './domain/avatar.ts';
import type { IssueTracker } from './domain/ports/issue-tracker.ts';
import type { SpeechSynthesizer } from './domain/ports/speech-synthesizer.ts';
import { createAvatarEventBroadcaster } from './infrastructure/avatar/avatar-event-broadcaster.ts';
import { createFileModelReader } from './infrastructure/avatar/file-model-reader.ts';
import { createMemorySpeechAudioStore } from './infrastructure/avatar/memory-speech-audio-store.ts';
import { openAppDatabase } from './infrastructure/db/app-database.ts';
import { createDiscordApprovalPrompt } from './infrastructure/discord/approval-prompt.ts';
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
import { createJevReactionClassifier } from './infrastructure/reaction/jev-reaction-classifier.ts';
import { createSqliteReminderStore } from './infrastructure/reminder/sqlite-reminder-store.ts';
import { createBraveSearcher } from './infrastructure/search/brave-search.ts';
import {
  createSettingsFileEditor,
  createSettingsFileProvider,
} from './infrastructure/settings/settings-file.ts';
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
  // 承認をその場で聞く（F-44）。**Client ではなくトークンで動く** ——
  // キュレーターのツールは Gateway が ready になる前から組み立てられる。
  prompt: createDiscordApprovalPrompt({ token: env.DISCORD_BOT_TOKEN }),
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

/**
 * アバターへ流すイベントの配り口（F-21, F-22）。
 *
 * **1 つだけ作る。** 出す側（発話キュー・1 ターンの実行）と受け取る側
 * （SSE のルート）が同じ実体を見ていないと、口が動かないまま声だけ出る。
 */
export const avatarEvents = createAvatarEventBroadcaster({ log: logger });

/**
 * ブラウザで鳴らす音の置き場（F-23）。**メモリだけ・直近だけ**（→ D-39 の 5）。
 *
 * 出す側（発話キュー）と取り出す側（HTTP のルート）が同じ実体を見る。
 */
const speechAudio = createMemorySpeechAudioStore();

/** 会話の状態（F-22）。数えて一番強いものを出す。 */
export const avatarPresence: AvatarPresence =
  createAvatarPresence(avatarEvents);

/** アバターの表示（F-20）。VRM は設定ファイルが指す 1 ファイル（→ D-36 の 2）。 */
export const avatarDependencies: AvatarDependencies = {
  settings,
  models: createFileModelReader(),
  events: avatarEvents,
  audio: speechAudio,
  log: logger,
};

/** 設定ファイルの現在値。表示整形（Discord 側）からも読む。 */
export const settingsProvider = settings;

/**
 * 設定 UI（F-61）が使う書き込み口。**読む口とは別の port**（→ D-44）。
 *
 * **これを渡すのは設定 UI のハンドラだけ。** 会話ロジック（エージェント・
 * ツール・poller）には `settings`（読むだけ）しか渡っていない —— そうして
 * おくことで「会話ロジックは設定ファイルへ書かない」（INV-9）が、規約では
 * なく配線で守られる。
 */
const settingsEditor = createSettingsFileEditor(env.SETTINGS_PATH);

/**
 * 声の一覧を取るために音声合成エンジンが要る。エンジンのクライアントは
 * Gateway が ready になってから作られる（`createVoiceRuntime`）ので、
 * ここでは受け取る形にしてある。
 */
export function settingsEditDependencies(
  synthesizer: SpeechSynthesizer,
): SettingsEditDependencies {
  return { editor: settingsEditor, synthesizer, log: logger };
}

/**
 * 発話に表情を付ける（F-24）。**鍵が無ければ作らない。**
 *
 * 起票（`GITHUB_TOKEN`）と違って呼ばれた時点で投げない —— 表情は発話の
 * たびに通る経路なので、投げると毎回 WARN が出てログが埋まる。無効で
 * あることは起動時に 1 行だけ出す（→ D-41 の 6）。
 */
function createReactionServiceFromEnv(): ReactionService | undefined {
  const apiKey = env.JEV_API_KEY;
  if (!apiKey) {
    logger.warn(
      {},
      'Expression control is disabled — JEV_API_KEY is not set (the avatar keeps a neutral face)',
    );
    return undefined;
  }
  return createReactionService({
    classifier: createJevReactionClassifier({ apiKey }),
    avatar: avatarEvents,
    // **見ている人がいるときだけ頼む。** 消音のタブでも顔は見えるので、
    // 出口の数（`listeningBrowsers`）ではなく購読者の数で数える。
    watching: () => avatarEvents.subscribers(),
    // 素材が置いてある身振りだけを出す（→ D-42 の 2）。設定ファイルは
    // 動いている間に書き換わりうるので、**毎回読み直す。**
    availableGestures: () => configuredGestures(settings.get()),
    now: () => Date.now(),
    log: logger,
  });
}

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
  const speech = createSpeechService({
    synthesizer,
    voice,
    // **つながっている出口**（→ D-40）。Discord VC とブラウザは対等で、
    // どちらか一方でも聞いていれば読み上げる。ここが内訳を知る唯一の場所。
    outputs: {
      current: () => ({
        voiceGuildId: voice.current()?.guildId,
        listeningBrowsers: avatarEvents.listeningBrowsers(),
      }),
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    avatar: avatarEvents,
    expression: createReactionServiceFromEnv(),
    audio: speechAudio,
    presence: avatarPresence,
    log: logger,
  });
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
      text,
      log: logger,
    },
  };
}
