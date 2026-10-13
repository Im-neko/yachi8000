/**
 * 連続会話の窓（F-01, D-50）。
 *
 * アシスタントが返信した相手が、同じチャンネルで続けて書いたときに、
 * メンション無しでも応答するための状態。判定は「誰が・どこで・いつ」だけで
 * 決める決定的な規則で、LLM に応答すべきかを判定させない（F-01）。
 *
 * **窓は返信のたびに開き直す。** 最後の返信から `durationMs` が過ぎれば閉じる。
 * プロセスの再起動で窓は消える —— その場合はメンションし直すだけで、
 * 会話の履歴そのものは Flue が持っている（F-02）。
 */
export class ConversationWindow {
  private readonly openUntil = new Map<string, number>();

  constructor(private readonly durationMs: number) {}

  /** 返信した相手との窓を開く（開いていれば延ばす）。 */
  open(channelId: string, speakerId: string, now: number): void {
    this.prune(now);
    this.openUntil.set(keyOf(channelId, speakerId), now + this.durationMs);
  }

  /** 窓の中か。 */
  isOpen(channelId: string, speakerId: string, now: number): boolean {
    const until = this.openUntil.get(keyOf(channelId, speakerId));
    return until !== undefined && now < until;
  }

  /** 閉じた窓を捨てる。溜め続けないための掃除で、判定には影響しない。 */
  private prune(now: number): void {
    for (const [key, until] of this.openUntil) {
      if (now >= until) this.openUntil.delete(key);
    }
  }
}

function keyOf(channelId: string, speakerId: string): string {
  return `${channelId}:${speakerId}`;
}
