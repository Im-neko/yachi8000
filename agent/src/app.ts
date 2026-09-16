import { setProvider } from '@flue/runtime';
import { Hono } from 'hono';
import type { ReminderDeliveryDependencies } from './application/reminder.ts';
import { fireDueReminders } from './application/reminder.ts';
import {
  createVoiceRuntime,
  memoryStore,
  personaDependencies,
  settingsProvider,
  skillDependencies,
} from './composition-root.ts';
import { env } from './config/env.ts';
import { startDiscordGateway } from './infrastructure/discord/gateway.ts';
import { createLlmProxyProvider } from './infrastructure/llm/provider.ts';
import { registerMessageHandler } from './interfaces/discord/message-handler.ts';
import { registerSlashCommands } from './interfaces/discord/slash-commands.ts';
import { createDebugRouter } from './interfaces/http/debug-routes.ts';
import { createNotifyRouter } from './interfaces/http/notify-routes.ts';
import { logger } from './observability/logger.ts';

/**
 * 合成ルート。起動時の配線をここで済ませ、どれか 1 つでも失敗したら
 * 起動を止める —— 記憶が書けない、モデルが解決できない、合成エンジンが
 * 契約を満たさない、Discord に繋がらない、のいずれも「動いているように
 * 見えて壊れている」状態を作る。
 */

// Flue 組み込みのモデルカタログには載っていないモデルを使うため、
// プロキシに実在するモデルを起動時に取りに行ってから登録する。
setProvider(
  await createLlmProxyProvider({
    baseUrl: env.LLM_PROXY_BASE_URL,
    apiKey: env.LLM_PROXY_API_KEY,
    model: env.LLM_MODEL,
  }),
);

await memoryStore.ensureSchema();

const client = await startDiscordGateway(env.DISCORD_BOT_TOKEN);
const voice = createVoiceRuntime(client);

// 合成だけ通ってリップシンクが黙って壊れる、を防ぐ（F-12, D-05）。
await voice.synthesizer.verifyContract();

registerMessageHandler(client, {
  speech: voice.speech,
  voice: voice.voiceSession,
});
await registerSlashCommands(client, {
  voice: voice.voiceSession,
  skills: skillDependencies,
  persona: personaDependencies,
});

/**
 * リマインダーの poller（F-31）。
 *
 * `setInterval` ではなく 1 回ごとに次を仕込む。**間隔は設定ファイルから毎回
 * 読み直す**ので、書き換えれば次の確認から効く（再起動が要らない）。
 * 起動時に期限が過ぎているものは、最初の確認でまとめて発火する —— 止まって
 * いた間のリマインダーを黙って捨てない（**繰り返しだけは 1 回に畳む**。
 * 同じ文面が連続で鳴るほうが害が大きい → D-29）。
 */
function startReminderPoller(deps: ReminderDeliveryDependencies): void {
  async function tick(): Promise<void> {
    try {
      const fired = await fireDueReminders(deps, new Date());
      if (fired > 0) logger.debug({ fired }, 'Reminder poll fired reminders');
    } catch (error) {
      // 1 回の失敗でループを止めない。止まると以後すべてのリマインダーが
      // 黙って鳴らなくなる（気付けない壊れ方）。
      logger.error({ err: error }, 'Reminder poll failed');
    } finally {
      const seconds =
        settingsProvider.get().behavior.reminderPollIntervalSeconds;
      setTimeout(() => void tick(), seconds * 1000).unref();
    }
  }

  void tick();
  logger.info(
    {
      intervalSeconds:
        settingsProvider.get().behavior.reminderPollIntervalSeconds,
    },
    'Started the reminder poller',
  );
}

startReminderPoller(voice.reminder);

const app = new Hono();
app.get('/api/v1/health', (c) => c.json({ status: 'ok' }));

app.route(
  '/api/v1',
  createNotifyRouter({
    tokens: env.NOTIFY_TOKENS,
    notifyDependencies: voice.notify,
    voiceDependencies: voice.voiceSession,
    log: logger,
  }),
);

if (env.DEBUG_MODE) {
  app.route('/debug', createDebugRouter(voice.voiceSession));
  logger.warn(
    'DEBUG_MODE=true — /debug/* が有効です（認証なしで発話させられます）',
  );
}

logger.info(
  { version: env.APP_VERSION, environment: env.ENVIRONMENT },
  'yachi8000 agent started',
);

export default app;
