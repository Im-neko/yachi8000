import * as v from 'valibot';
import type { Embedder } from '../../domain/ports/embedder.ts';

/**
 * 埋め込みモデルと次元数はコード上の定数（D-15）。
 *
 * 次元数は pgvector のカラム定義と一体で、作成後に変えられない。設定で
 * 可変にすると、設定を変えた瞬間に既存の記憶が全部引けなくなる。
 */
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

const EmbeddingResponseSchema = v.object({
  data: v.array(
    v.object({
      index: v.number(),
      embedding: v.array(v.number()),
    }),
  ),
});

export interface CreateProxyEmbedderInput {
  /** `/v1` まで含めたベース URL。 */
  baseUrl: string;
  apiKey: string;
}

/**
 * LLM プロキシの `/embeddings` を直接叩く。
 *
 * Flue の `setProvider` はチャット用の抽象で、埋め込みは通らない。
 */
export function createProxyEmbedder(input: CreateProxyEmbedderInput): Embedder {
  const url = `${input.baseUrl.replace(/\/$/, '')}/embeddings`;

  async function embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
    });
    if (!response.ok) {
      throw new Error(
        `埋め込みの取得に失敗しました: ${response.status} ${response.statusText}`,
      );
    }

    const parsed = v.safeParse(EmbeddingResponseSchema, await response.json());
    if (!parsed.success) {
      throw new Error(
        `埋め込み API の応答を解釈できませんでした: ${v.summarize(parsed.issues)}`,
      );
    }
    if (parsed.output.data.length !== texts.length) {
      throw new Error(
        `埋め込みの件数が一致しません: ${texts.length} 件を送って ${parsed.output.data.length} 件が返りました。`,
      );
    }

    // API は index 順を保証しない。並べ直してから返す。
    const vectors: number[][] = new Array(texts.length);
    for (const item of parsed.output.data) {
      if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `埋め込みの次元数が ${EMBEDDING_DIMENSIONS} ではありません: ${item.embedding.length}。モデル "${EMBEDDING_MODEL}" の設定を確認してください。`,
        );
      }
      vectors[item.index] = item.embedding;
    }
    return vectors;
  }

  return {
    dimensions: EMBEDDING_DIMENSIONS,
    embedDocuments: embed,
    async embedQuery(text) {
      const [vector] = await embed([text]);
      if (!vector) throw new Error('埋め込みが返りませんでした。');
      return vector;
    },
  };
}
