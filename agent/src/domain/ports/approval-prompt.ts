/**
 * 承認を「その場で聞く」口（F-44）。
 *
 * **Discord の Client ではなく REST で実装する。** キュレーターのツールは
 * 合成ルートのモジュール変数から依存を取るが、Client は Gateway が ready に
 * なってからしか作れない（`createVoiceRuntime`）。聞いて印を付けるだけの
 * ために Client を配るより、トークン 1 本で完結するほうが配線が短い
 * （→ `MessageMarker` と同じ判断）。
 */
export interface ApprovalPrompt {
  /**
   * 問いかけを投稿し、承認・否認のリアクションを先に付ける。
   *
   * **先に付けるのは「押せる」ことを見せるため。** 何も付いていないと、
   * 何で答えればいいのか分からない。
   *
   * @returns 投稿したメッセージの ID。
   */
  ask(channelId: string, text: string): Promise<string>;
  /**
   * 決まったあとに文面を差し替える（F-44）。
   *
   * **問いかけのまま残さない。** 過去ログを遡った人が、決着済みの問いを
   * もう一度押すことになる。
   */
  settle(channelId: string, messageId: string, text: string): Promise<void>;
}

/** 承認の印。**`MessageMarker` の「処理済み」と同じ絵文字**にしてある。 */
export const APPROVE_EMOJI = '✅';
/** 否認の印。 */
export const REJECT_EMOJI = '❌';
