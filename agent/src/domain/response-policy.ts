/**
 * 応答判定の入力。Discord の型には依存させない —— 判定規則そのものを
 * 単体テストできる形にしておくことが F-01 の受け入れ条件。
 */
export interface IncomingMessageContext {
  /** DM かどうか。DM は常に応答する。 */
  isDirectMessage: boolean;
  /** アシスタント自身への明示的メンションが本文に含まれるか。 */
  mentionsAssistant: boolean;
  /**
   * アシスタントが返信した相手が、同じチャンネルで続けて書いているか
   * （連続会話の窓の中か。→ D-50）。
   */
  inConversationWindow: boolean;
  /** アシスタント以外の誰かへのメンションが含まれるか。 */
  mentionsSomeoneElse: boolean;
  /** 送信者が Bot（自分自身を含む）か。 */
  authorIsBot: boolean;
  /** 本文が空でないか。 */
  hasText: boolean;
}

/**
 * 応答するかどうか。
 *
 * DM は常に応答、サーバのチャンネルは明示的メンションがあるときだけ応答する。
 * 例外は連続会話の窓の中（D-50）: 返信した相手が同じチャンネルで続けて書いたときは
 * メンション無しでも応答する。ただし別の誰かへ宛てた発言（他の人へのメンション付き）
 * は拾わない。
 * LLM に「応答すべきか」を判定させたり、暗黙のパターンマッチで拾ったりしない
 * （先行実装 で廃止済みの経路）。窓も「誰が・どこで・いつ」だけで決める。
 *
 * Bot の発言には応答しない。自分の発言に自分で反応する無限ループを、
 * 判定の側で止める。
 */
export function shouldRespond(context: IncomingMessageContext): boolean {
  if (context.authorIsBot) return false;
  if (!context.hasText) return false;
  if (context.isDirectMessage || context.mentionsAssistant) return true;
  return context.inConversationWindow && !context.mentionsSomeoneElse;
}
