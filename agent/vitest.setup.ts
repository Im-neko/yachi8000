// .env はローカル開発時にだけ存在する。CI は環境変数を直接与える。
try {
  process.loadEnvFile(new URL('.env', import.meta.url));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

// 単体テストは外部サービスへ接続しないが、モジュールを import した時点で
// env.ts のスキーマ検証が走る。未設定のものにだけダミー値を与える
// （本物が渡っていればそちらを使う）。
const testDefaults: Record<string, string> = {
  LLM_PROXY_BASE_URL: 'http://llm-proxy.test/v1',
  LLM_PROXY_API_KEY: 'test-key',
  LLM_MODEL: 'test-model',
  DISCORD_BOT_TOKEN: 'test-token',
  MEMORY_DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  VOICEVOX_URL: 'http://voicevox.test',
  NOTIFY_TOKENS: 'test-source:test-notify-token',
  BRAVE_SEARCH_API_KEY: 'test-brave-key',
  // ランタイム状態はテストごとにインメモリで作る。ファイルを触らせない。
  APP_DB_PATH: ':memory:',
};

for (const [name, value] of Object.entries(testDefaults)) {
  process.env[name] ??= value;
}
