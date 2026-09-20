import type { AvatarEvent } from '../avatar-event.ts';

/**
 * アバターへイベントを流す口（F-21, F-22）。
 *
 * **投げっぱなし。** 発話も 1 ターンの実行も、見ている人がいるかどうかで
 * 止まってはならない —— 誰も見ていないときに読み上げが遅くなる、という
 * 逆立ちした依存を作らないため。実装側は例外を外へ出さないこと。
 */
export interface AvatarEventPublisher {
  publish(event: AvatarEvent): void;
}

/**
 * 流れてくるイベントを受け取る口。SSE のルート（F-21）が使う。
 *
 * **購読した直後に「今の状態」が 1 回流れてくる。** 読み上げの途中で
 * ページを開いた人が、次の発話まで待機の顔のまま止まらないようにするため。
 */
export interface AvatarEventSource {
  /** 戻り値を呼ぶと購読をやめる。 */
  subscribe(listener: (event: AvatarEvent) => void): () => void;
}
