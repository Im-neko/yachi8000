import type { AvatarState } from '../domain/avatar-event.ts';
import { AVATAR_STATES } from '../domain/avatar-event.ts';
import type { AvatarEventPublisher } from '../domain/ports/avatar-event-publisher.ts';

/**
 * 会話の状態を 1 箇所で持つ（F-22）。
 *
 * **状態を出す側が 2 つある。** 発話キュー（読み上げている）と 1 ターンの
 * 実行（考えている）で、しかも**重なる** —— 考えている最中に前の発話が
 * まだ鳴っていることがある。それぞれが勝手に `idle` を出すと、もう一方が
 * 動いているのに「待機」になる。
 *
 * そこで**数える**。入っているものが 1 つでもあれば、その中で一番強い状態を
 * 出す（→ `AVATAR_STATES`）。変わったときだけ出す。
 */
export interface AvatarPresence {
  /** 1 ターンの実行を始める。戻り値を呼ぶと終わる。 */
  beginThinking(): () => void;
  /** 読み上げを始める。戻り値を呼ぶと終わる。 */
  beginSpeaking(): () => void;
  /** 今の状態。テストと状態表示用。 */
  current(): AvatarState;
}

export function createAvatarPresence(
  publisher: AvatarEventPublisher,
): AvatarPresence {
  const active = new Map<AvatarState, number>();
  let published: AvatarState = 'idle';

  function current(): AvatarState {
    return (
      AVATAR_STATES.find((state) => (active.get(state) ?? 0) > 0) ?? 'idle'
    );
  }

  function sync(): void {
    const state = current();
    if (state === published) return;
    published = state;
    publisher.publish({ kind: 'state', state });
  }

  function begin(state: AvatarState): () => void {
    active.set(state, (active.get(state) ?? 0) + 1);
    sync();

    // **二重に呼ばれても 1 回しか戻さない。** 終了処理は finally から呼ばれる
    // ので、経路が増えたときに数が合わなくなるのが一番ありそうな壊れ方。
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      active.set(state, (active.get(state) ?? 1) - 1);
      sync();
    };
  }

  return {
    beginThinking: () => begin('thinking'),
    beginSpeaking: () => begin('speaking'),
    current,
  };
}
