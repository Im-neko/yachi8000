/**
 * `useModel()` に渡すモデル指定子の接頭辞。Flue は `provider-id/model-id`
 * の形でしか解決しない。
 *
 * プロバイダ本体（provider.ts）と別ファイルにしてあるのは、エージェント
 * モジュールがこの定数を使うだけのために pi-ai を巻き込まないようにするため。
 */
export const LLM_PROVIDER_ID = 'llm-proxy';
