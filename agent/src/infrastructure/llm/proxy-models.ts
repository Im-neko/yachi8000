import type { Model } from '@earendil-works/pi-ai';
import * as v from 'valibot';

/**
 * LLM プロキシ（LiteLLM）の `/model/info` が返すモデルの素性。
 *
 * コンテキスト長は Flue の自動圧縮（F-02）の判断に使われるため、
 * 値を推測で埋めてはいけない。プロキシが実際に持っている値を起動時に
 * 取りに行き、無いモデルは候補から外す。
 */
const ModelInfoSchema = v.object({
  max_input_tokens: v.nullish(v.number()),
  max_output_tokens: v.nullish(v.number()),
  input_cost_per_token: v.nullish(v.number()),
  output_cost_per_token: v.nullish(v.number()),
  cache_read_input_token_cost: v.nullish(v.number()),
  cache_creation_input_token_cost: v.nullish(v.number()),
  mode: v.nullish(v.string()),
  supports_vision: v.nullish(v.boolean()),
  supports_reasoning: v.nullish(v.boolean()),
  supports_function_calling: v.nullish(v.boolean()),
});

const ModelInfoResponseSchema = v.object({
  data: v.array(
    v.object({
      model_name: v.string(),
      model_info: ModelInfoSchema,
    }),
  ),
});

/** pi-ai の `ModelCost` は 100 万トークンあたりの単価。LiteLLM は 1 トークンあたり。 */
const TOKENS_PER_COST_UNIT = 1_000_000;

function rate(perToken: number | null | undefined): number {
  return (perToken ?? 0) * TOKENS_PER_COST_UNIT;
}

export interface ChatModelCapability {
  model: Model<'openai-completions'>;
  supportsFunctionCalling: boolean;
}

export interface FetchChatModelsInput {
  providerId: string;
  /** `/v1` まで含めたベース URL。 */
  baseUrl: string;
  apiKey: string;
}

/**
 * プロキシが公開しているチャットモデルを取得する。
 *
 * コンテキスト長・最大出力長が欠けているモデルは返さない。値が無いまま
 * 0 を埋めると圧縮の閾値が壊れ、会話が黙って壊れる。
 */
export async function fetchChatModels(
  input: FetchChatModelsInput,
): Promise<ChatModelCapability[]> {
  const url = `${input.baseUrl.replace(/\/$/, '')}/model/info`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${input.apiKey}` },
  });
  if (!response.ok) {
    throw new Error(
      `LLM プロキシのモデル一覧を取得できませんでした: ${response.status} ${response.statusText}`,
    );
  }

  const parsed = v.safeParse(ModelInfoResponseSchema, await response.json());
  if (!parsed.success) {
    throw new Error(
      `LLM プロキシの /model/info の応答を解釈できませんでした: ${v.summarize(parsed.issues)}`,
    );
  }

  const capabilities: ChatModelCapability[] = [];
  for (const entry of parsed.output.data) {
    const info = entry.model_info;
    if (info.mode !== 'chat') continue;
    const contextWindow = info.max_input_tokens;
    const maxTokens = info.max_output_tokens;
    if (!contextWindow || !maxTokens) continue;

    capabilities.push({
      supportsFunctionCalling: info.supports_function_calling === true,
      model: {
        id: entry.model_name,
        name: entry.model_name,
        api: 'openai-completions',
        provider: input.providerId,
        baseUrl: input.baseUrl,
        reasoning: info.supports_reasoning === true,
        input: info.supports_vision === true ? ['text', 'image'] : ['text'],
        cost: {
          input: rate(info.input_cost_per_token),
          output: rate(info.output_cost_per_token),
          cacheRead: rate(info.cache_read_input_token_cost),
          cacheWrite: rate(info.cache_creation_input_token_cost),
        },
        contextWindow,
        maxTokens,
      },
    });
  }
  return capabilities;
}
