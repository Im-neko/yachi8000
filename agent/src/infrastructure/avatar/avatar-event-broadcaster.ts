import type { AvatarEvent } from '../../domain/avatar-event.ts';
import type {
  AvatarEventPublisher,
  AvatarEventSource,
} from '../../domain/ports/avatar-event-publisher.ts';

/**
 * プロセスの中だけで配る（F-21, F-22）。
 *
 * **レプリカは 1 本**（Gateway 接続と再生キューが単一プロセスに閉じている
 * → INV-5、デプロイ上の制約）なので、プロセスをまたいで配る仕組みは要らない。
 * 増やすことになったら、そのときは発話の経路そのものを先に考え直すことになる。
 */
export interface AvatarEventBroadcaster
  extends AvatarEventPublisher,
    AvatarEventSource {
  /** 今つながっている購読者の数。ログと状態表示用。 */
  subscribers(): number;
}

export interface CreateAvatarEventBroadcasterInput {
  log: {
    error(context: Record<string, unknown>, message: string): void;
  };
}

export function createAvatarEventBroadcaster(
  input: CreateAvatarEventBroadcasterInput,
): AvatarEventBroadcaster {
  const listeners = new Set<(event: AvatarEvent) => void>();

  /**
   * 最後に出した状態（F-22）。**購読した直後にこれを流す。**
   * 口形（`speech`）は溜めない —— 過ぎた発話の口を後から動かしても意味がない。
   */
  let state: AvatarEvent = { kind: 'state', state: 'idle' };

  function emit(listener: (event: AvatarEvent) => void, event: AvatarEvent) {
    try {
      listener(event);
    } catch (error) {
      // 1 人の購読者が投げても、読み上げも他の購読者も巻き込まない。
      input.log.error(
        { err: error, kind: event.kind },
        'An avatar event listener threw — dropped that one delivery',
      );
    }
  }

  return {
    publish(event) {
      if (event.kind === 'state') state = event;
      for (const listener of listeners) emit(listener, event);
    },

    subscribe(listener) {
      listeners.add(listener);
      emit(listener, state);
      return () => {
        listeners.delete(listener);
      };
    },

    subscribers: () => listeners.size,
  };
}
