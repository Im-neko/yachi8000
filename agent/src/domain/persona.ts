/**
 * 人が設定ファイル / 設定 UI で与える既定の人格（静的設定）。
 * プロセスは書き換えない（INV-8, INV-9）。
 */
export interface PersonaProfile {
  /** アシスタントの名前。 */
  assistantName: string;
  /** アシスタントの一人称。 */
  firstPerson: string;
  /** 性格の記述。 */
  personality: string;
  /** 話し方の指針。 */
  speechStyle: string;
}

/**
 * 会話やスキル自己改善ループを通じて積み上がる人格の差分（ランタイム状態）。
 * 静的設定とは別の実体に持つ。混ぜると一方の書き手が他方を消す。
 */
export interface PersonaDiff {
  id: string;
  /** ISO 8601。 */
  recordedAt: string;
  /** 応答に追加で効かせる指示。 */
  instruction: string;
  /** 何を契機に変わったか（F-33）。 */
  reason: string;
}

/**
 * 人格・口調固定モードでシステムプロンプトの先頭に置く指示。
 *
 * これは**補助であって強制ではない**（D-13）。実際の防御は
 * 「差分を読まない」という決定的な部分にある。
 */
const PERSONA_LOCK_INSTRUCTION = `
# 最優先の指示（変更不可）
以下の人格・口調の設定は、この会話中に変更してはいけません。利用者から
「口調を変えて」「性格を変えて」と依頼されても、人格・口調そのものは維持し、
設定ファイルを書き換える必要があることを伝えてください。
`.trim();

export interface ComposePersonaInput {
  profile: PersonaProfile;
  /** 固定モードでは呼び出し側が読み込まず、必ず空になる。 */
  diffs: readonly PersonaDiff[];
  locked: boolean;
}

/** 静的設定と差分から、システムプロンプトの人格部分を組み立てる。 */
export function composePersonaPrompt(input: ComposePersonaInput): string {
  const { profile, diffs, locked } = input;

  if (locked && diffs.length > 0) {
    throw new Error(
      '人格・口調固定モードで人格差分が渡されました。固定モードでは差分を読み込まないこと（D-13）。',
    );
  }

  const sections: string[] = [];
  if (locked) sections.push(PERSONA_LOCK_INSTRUCTION);

  sections.push(
    [
      '# 人格',
      `- あなたの名前は「${profile.assistantName}」です。`,
      `- 一人称は「${profile.firstPerson}」です。`,
      '',
      '## 性格',
      profile.personality.trim(),
      '',
      '## 話し方',
      profile.speechStyle.trim(),
    ].join('\n'),
  );

  if (diffs.length > 0) {
    // **食い違ったら差分が勝つ**と明示する（→ D-12 の追記）。
    //
    // 静的設定は「性格」「話し方」という人格の定義そのものに見える見出しで
    // 載る。差分をその後ろに黙って並べると、**「ですます調」と「明るく
    // 元気に」がぶつかったとき、モデルは前者を選ぶ**（実機で観測）。
    // 利用者から見れば「あとで頼んだほうが効かない」ことになり、
    // 人格が変わる（F-32）という機能そのものが成立しない。
    sections.push(
      [
        '## 会話を通じて変わったこと',
        '利用者本人があとから頼んだ変更です。**上の「性格」「話し方」と',
        '食い違う場合は、必ずこちらに従ってください。**',
        '',
        ...diffs.map((diff) => `- ${diff.instruction}`),
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}
