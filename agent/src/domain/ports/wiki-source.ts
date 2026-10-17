export interface WikiHit {
  path: string;
  title: string;
  description: string;
  locale: string;
}

export interface WikiPage extends WikiHit {
  /** Markdown の本文。 */
  content: string;
  updatedAt: string;
}

/**
 * 社内 wiki の読み取り口（F-55）。**読むだけ。** 取れなかったときは投げる ——
 * 「見つからなかった」に倒すと、wiki が落ちていても「載っていない」と答えてしまう。
 * ページが無いことだけは `undefined` で返す。
 */
export interface WikiSource {
  search(query: string): Promise<WikiHit[]>;
  read(path: string, locale: string): Promise<WikiPage | undefined>;
}
