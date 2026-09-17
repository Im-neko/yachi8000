import * as v from 'valibot';

/** 文面づくりの応答待ち。これを超えたら失敗として縮退させる。 */
const COMPLETION_TIMEOUT_MS = 8_000;

const CompletionSchema = v.object({
  choices: v.pipe(
    v.array(
      v.object({ message: v.object({ content: v.nullable(v.string()) }) }),
    ),
    v.minLength(1),
  ),
});

export interface CompleteInput {
  /** 役割と出力規則。人格の指定もここに含めて渡す。 */
  system: string;
  /** **非信頼データ**。JSON にして渡し、指示と構造的に分ける（INV-4）。 */
  user: string;
  /** これを超える出力は失敗とみなす。読み上げ文として扱えない長さ。 */
  maxLength: number;
}

/** 1 往復だけの文面づくり。会話履歴もツールも持たない。 */
export type ChatCompleter = (input: CompleteInput) => Promise<string>;

export interface CreateChatCompleterInput {
  /** `/v1` まで含めたベース URL。 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** エラー文に出す呼び出し元の名前（「通知の書き換え」など）。 */
  label: string;
}

/**
 * LLM プロキシの `/chat/completions` を 1 往復だけ叩く。
 *
 * 会話エージェント（Flue）を通さないことが要件そのもの（INV-3, INV-4）。
 * エージェントに通すと会話履歴とツールがどちらも付いてくる。
 *
 * **失敗は必ず投げる。** 呼び出し側が縮退を決め、WARN を出す（INV-7）。
 * ここで空文字や既定文へ倒すと、縮退したことが誰にも見えなくなる。
 */
export function createChatCompleter(
  input: CreateChatCompleterInput,
): ChatCompleter {
  const url = `${input.baseUrl.replace(/\/$/, '')}/chat/completions`;

  return async ({ system, user, maxLength }) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `${input.label}に失敗しました: ${response.status} ${response.statusText}`,
      );
    }

    const parsed = v.safeParse(CompletionSchema, await response.json());
    if (!parsed.success) {
      throw new Error(
        `${input.label}の応答を解釈できませんでした: ${v.summarize(parsed.issues)}`,
      );
    }

    const text = parsed.output.choices[0]?.message.content?.trim() ?? '';
    if (text === '') {
      throw new Error(`${input.label}の結果が空でした。`);
    }
    if (text.length > maxLength) {
      throw new Error(
        `${input.label}の結果が長すぎます（${text.length} 文字）。読み上げ文として扱えません。`,
      );
    }
    return text;
  };
}
