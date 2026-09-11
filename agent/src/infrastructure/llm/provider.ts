import {
  createProvider,
  envApiKeyAuth,
  type Provider,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { logger } from '../../observability/logger.ts';
import { LLM_PROVIDER_ID } from './provider-id.ts';
import { fetchChatModels } from './proxy-models.ts';

export interface CreateLlmProxyProviderInput {
  baseUrl: string;
  apiKey: string;
  /** 使うモデル。プロキシに実在し、かつツール呼び出しに対応している必要がある。 */
  model: string;
}

/**
 * LLM プロキシを単一の LLM 入口として登録する（D-17）。
 *
 * Flue 組み込みのモデルカタログには載っていないモデルを使うための経路。
 * カタログの代わりにプロキシ自身へ問い合わせるので、モデルを増やしても
 * このコードは変わらない。
 */
export async function createLlmProxyProvider(
  input: CreateLlmProxyProviderInput,
): Promise<Provider<'openai-completions'>> {
  const capabilities = await fetchChatModels({
    providerId: LLM_PROVIDER_ID,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
  });

  const selected = capabilities.find((c) => c.model.id === input.model);
  if (!selected) {
    const available = capabilities.map((c) => c.model.id).join(', ');
    throw new Error(
      `LLM_MODEL="${input.model}" は LLM プロキシのチャットモデルにありません。利用できるのは: ${available || '(なし)'}`,
    );
  }
  if (!selected.supportsFunctionCalling) {
    throw new Error(
      `LLM_MODEL="${input.model}" はツール呼び出しに対応していません。ツールが黙って無視される構成では動かせません。`,
    );
  }

  logger.info(
    {
      model: selected.model.id,
      contextWindow: selected.model.contextWindow,
      maxTokens: selected.model.maxTokens,
      availableModels: capabilities.length,
    },
    'Registered the LLM proxy provider',
  );

  return createProvider({
    id: LLM_PROVIDER_ID,
    name: 'LLM proxy',
    baseUrl: input.baseUrl,
    auth: {
      apiKey: envApiKeyAuth('LLM proxy API key', ['LLM_PROXY_API_KEY']),
    },
    models: capabilities.map((c) => c.model),
    api: openAICompletionsApi(),
  });
}
