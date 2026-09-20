import {
  type ChannelRouteDefinition,
  createChannelRouter,
} from '@flue/runtime';
import { streamSSE } from 'hono/streaming';
import {
  type AvatarDependencies,
  avatarModel,
  avatarView,
  subscribeAvatarEvents,
} from '../../application/avatar.ts';

/** VRM の media type。glTF バイナリと同じ形式。 */
const VRM_CONTENT_TYPE = 'model/gltf-binary';

/**
 * 何も起きていない間に流すコメント行の間隔。
 *
 * **無音のまま放っておくと、間に立つもの（ingress・ブラウザ）が切る。**
 * `EventSource` は切れても繋ぎ直すが、繋ぎ直しの間に来た発話は落ちる ——
 * ちょうど口が動かない時間ができる。
 */
const KEEP_ALIVE_INTERVAL_MS = 25_000;

/**
 * アバターの表示に要るもの（F-20）。
 *
 * **この 3 本に認証は無い**（→ D-36 の 4、D-37）。守るのは ingress 側で、
 * アプリには認証のコードを入れない。**通知 API（F-18）とは別物** ——
 * あちらは「発話させられる入口」なので自前のトークンを持ち続ける。
 *
 * **VRM のパスはリクエストから受け取らない。** 設定ファイルが指す 1 つだけを
 * 読む（→ D-36 の 2）。受けたパスを読む作りにすると、表示のために開けた口が
 * ファイルシステムの覗き穴になる。
 */
export function createAvatarRouter(deps: AvatarDependencies) {
  const getConfig: ChannelRouteDefinition['handler'] = (c) => {
    const view = avatarView(deps);
    if (!view) {
      return c.json(
        { error: 'アバターが設定されていません（settings の avatar）。' },
        404,
      );
    }
    return c.json(view);
  };

  const getModel: ChannelRouteDefinition['handler'] = async (c) => {
    const result = await avatarModel(deps);
    if (result.kind === 'not-configured') {
      return c.json(
        { error: 'アバターが設定されていません（settings の avatar）。' },
        404,
      );
    }
    if (result.kind === 'missing') {
      // 置き場所は応答に載せない（ログには出してある）。
      return c.json(
        { error: '設定された VRM ファイルが置かれていません。' },
        404,
      );
    }

    return c.body(result.bytes as unknown as ArrayBuffer, 200, {
      'content-type': VRM_CONTENT_TYPE,
      // 差し替えは人が手で行うので、長く持たせず毎回確かめさせる。
      'cache-control': 'no-cache',
    });
  };

  /**
   * 発話と会話状態の流れ（F-21, F-22）。**SSE**（→ D-38 の 1）。
   *
   * **一方向で足りる。** ブラウザから送り返すものは無く、`EventSource` の
   * 再接続がそのまま使える。**認証はここにも無い**（→ D-37）——
   * 読むだけで、発話させられる入口ではない。
   */
  const getEvents: ChannelRouteDefinition['handler'] = (c) =>
    streamSSE(c, async (stream) => {
      // ストリームが閉じるまで解決しない Promise。streamSSE はこの関数が
      // 返った時点で接続を閉じるので、待ち続ける必要がある。
      const closed = new Promise<void>((resolve) => {
        stream.onAbort(resolve);
      });

      const unsubscribe = subscribeAvatarEvents(deps, (event) => {
        // 書き込みは待たない。**遅い購読者のために読み上げを止めない**
        // （port の約束どおり投げっぱなし）。
        void stream
          .writeSSE({ event: event.kind, data: JSON.stringify(event) })
          .catch(() => undefined);
      });

      const keepAlive = setInterval(() => {
        void stream
          .writeSSE({ event: 'ping', data: '' })
          .catch(() => undefined);
      }, KEEP_ALIVE_INTERVAL_MS);

      try {
        await closed;
      } finally {
        clearInterval(keepAlive);
        unsubscribe();
      }
    });

  return createChannelRouter([
    { method: 'GET', path: '/avatar/config', handler: getConfig },
    { method: 'GET', path: '/avatar/model', handler: getModel },
    { method: 'GET', path: '/avatar/events', handler: getEvents },
  ]);
}
