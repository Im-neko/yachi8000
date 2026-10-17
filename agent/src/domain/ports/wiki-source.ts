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

export interface WikiPageDraft {
  path: string;
  locale: string;
  title: string;
  description: string;
  content: string;
}

export interface WikiReplacement {
  path: string;
  locale: string;
  content: string;
  /** 読んだときの `updatedAt`。ページがその後に変わっていたら書かずに投げる。 */
  expectedUpdatedAt: string;
}

/**
 * 社内 wiki の書き込み口（F-56）。**消す口は無い。**
 * 失敗したときは投げる（書けたことにしない）。
 */
export interface WikiEditor {
  /** 新しいページを作る。同じ path がすでにあれば投げる（上書きしない）。 */
  create(draft: WikiPageDraft): Promise<WikiPage>;
  /** 既存ページの本文を置き換える。タイトル・タグ・公開設定は残す。 */
  replaceContent(replacement: WikiReplacement): Promise<WikiPage>;
}
