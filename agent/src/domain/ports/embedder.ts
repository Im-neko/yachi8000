/**
 * テキストを埋め込みベクトルへ変換する。
 *
 * 次元数は保存先のスキーマと一体なので、設定で可変にせず実装側の定数で
 * 固定する（D-15）。Flue のプロバイダ抽象（`setProvider`）はチャット用で、
 * この経路は通らない。
 */
export interface Embedder {
  /** ベクトルの次元数。保存先のスキーマ検証に使う。 */
  readonly dimensions: number;
  embedDocuments(texts: readonly string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
