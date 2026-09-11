/**
 * 応答判定の入力。Discord の型には依存させない —— 判定規則そのものを
 * 単体テストできる形にしておくことが F-01 の受け入れ条件。
 */
export interface IncomingMessageContext {
  /** DM かどうか。DM は常に応答する。 */
  isDirectMessage: boolean;
  /** アシスタント自身への明示的メンションが本文に含まれるか。 */
  mentionsAssistant: boolean;
  /** 送信者が Bot（自分自身を含む）か。 */
  authorIsBot: boolean;
  /** 本文が空でないか。 */
  hasText: boolean;
}

/**
 * 応答するかどうか。
 *
 * DM は常に応答、サーバのチャンネルは明示的メンションがあるときだけ応答する。
 * LLM に「応答すべきか」を判定させたり、暗黙のパターンマッチで拾ったりしない
 * （先行実装 で廃止済みの経路）。
 *
 * Bot の発言には応答しない。自分の発言に自分で反応する無限ループを、
 * 判定の側で止める。
 */
export function shouldRespond(context: IncomingMessageContext): boolean {
  if (context.authorIsBot) return false;
  if (!context.hasText) return false;
  return context.isDirectMessage || context.mentionsAssistant;
}
