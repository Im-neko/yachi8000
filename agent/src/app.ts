import { setProvider } from '@flue/runtime';
import { Hono } from 'hono';
import { createVoiceRuntime, memoryStore } from './composition-root.ts';
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
await registerSlashCommands(client, voice.voiceSession);

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
