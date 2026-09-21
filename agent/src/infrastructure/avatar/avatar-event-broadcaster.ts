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
  /**
   * 全員の購読を打ち切る。**停止処理から呼ぶ**（→ D-38 の 5）。
   *
   * Flue のチャンネルルーターは**流しっぱなしの応答が終わるまで停止を待つ**
   * （`retainActivityLease`）。ページを開いたままの人が 1 人いるだけで、
   * デプロイのたびに停止がタイムアウトまでぶら下がる。
   */
  closeAll(): void;
}

export interface CreateAvatarEventBroadcasterInput {
  log: {
    error(context: Record<string, unknown>, message: string): void;
  };
}

export function createAvatarEventBroadcaster(
  input: CreateAvatarEventBroadcasterInput,
): AvatarEventBroadcaster {
  interface Subscriber {
    deliver(event: AvatarEvent): void;
    close?: () => void;
    /** 音を鳴らせると名乗っているか（→ D-40）。 */
    audio: boolean;
  }

  const listeners = new Set<Subscriber>();

  /**
   * 最後に出した状態（F-22）。**購読した直後にこれを流す。**
   * 口形（`speech`）は溜めない —— 過ぎた発話の口を後から動かしても意味がない。
   */
  let state: AvatarEvent = { kind: 'state', state: 'idle' };

  function emit(subscriber: Subscriber, event: AvatarEvent) {
    try {
      subscriber.deliver(event);
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

    subscribe(listener, options) {
      const subscriber: Subscriber = {
        deliver: listener,
        close: options.onClose,
        audio: options.audio,
      };
      listeners.add(subscriber);
      emit(subscriber, state);
      return () => {
        listeners.delete(subscriber);
      };
    },

    subscribers: () => listeners.size,

    listeningBrowsers() {
      let listening = 0;
      for (const subscriber of listeners) if (subscriber.audio) listening++;
      return listening;
    },

    closeAll() {
      for (const subscriber of listeners) {
        try {
          subscriber.close?.();
        } catch (error) {
          input.log.error(
            { err: error },
            'Failed to close an avatar event subscriber',
          );
        }
      }
      listeners.clear();
    },
  };
}
