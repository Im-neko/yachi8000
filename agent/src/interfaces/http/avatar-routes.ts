import type { ChannelRouteDefinition } from '@flue/runtime';
import { streamSSE } from 'hono/streaming';
import {
  type AvatarDependencies,
  avatarGestureMotion,
  avatarModel,
  avatarSpeechAudio,
  avatarView,
  subscribeAvatarEvents,
} from '../../application/avatar.ts';

/** VRM の media type。glTF バイナリと同じ形式。 */
const VRM_CONTENT_TYPE = 'model/gltf-binary';

/** ブラウザで鳴らす音（F-23）。PCM に WAV のヘッダを付けて返す。 */
const SPEECH_CONTENT_TYPE = 'audio/wav';

/** VRMA の media type。VRM と同じ glTF バイナリ。 */
const MOTION_CONTENT_TYPE = 'model/gltf-binary';

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
 * **どれにも認証は無い**（→ D-36 の 4、D-37）。守るのは ingress 側で、
 * アプリには認証のコードを入れない。**通知 API（F-18）とは別物** ——
 * あちらは「発話させられる入口」なので自前のトークンを持ち続ける。
 *
 * **VRM のパスはリクエストから受け取らない。** 設定ファイルが指す 1 つだけを
 * 読む（→ D-36 の 2）。受けたパスを読む作りにすると、表示のために開けた口が
 * ファイルシステムの覗き穴になる。
 */
export function createAvatarRoutes(
  deps: AvatarDependencies,
): ChannelRouteDefinition[] {
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
   * 身振りの素材（F-25）。**VRM とまったく同じ扱い。**
   *
   * **種類はクエリで受けるが、パスは受けない。** 受け取った名前は語彙
   * （`AVATAR_GESTURES`）に入っているかを先に確かめ、実体の在りかは設定
   * ファイルからしか引かない（→ D-36 の 2）。
   *
   * **パスをクエリで受ける作りにすると、表示のために開けた口がそのまま
   * ファイルシステムの覗き穴になる。**
   */
  const getGestureMotion: ChannelRouteDefinition['handler'] = async (c) => {
    const result = await avatarGestureMotion(deps, c.req.query('kind') ?? '');
    if (result.kind === 'not-configured') {
      return c.json({ error: 'その身振りは設定されていません。' }, 404);
    }
    if (result.kind === 'missing') {
      return c.json(
        { error: '設定されたモーションファイルが置かれていません。' },
        404,
      );
    }
    return c.body(result.bytes as unknown as ArrayBuffer, 200, {
      'content-type': MOTION_CONTENT_TYPE,
      // 差し替えは人が手で行う。VRM と同じ扱いにしておく。
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
      //
      // **終わり方は 2 つある。** ブラウザが閉じたとき（onAbort）と、
      // こちらから打ち切ったとき（停止処理 → closeAll）。**後者が無いと、
      // 開いたままの配信が停止をぶら下げる** —— Flue のチャンネルルーターは
      // 流しっぱなしの応答が終わるまで待つ（→ D-38 の 5）。
      let finish: () => void = () => undefined;
      const closed = new Promise<void>((resolve) => {
        finish = resolve;
        stream.onAbort(resolve);
      });

      // **`?audio=1` は「このタブは音を鳴らせる」という名乗り**（F-23, D-40）。
      // 名乗ったタブだけを出口として数える —— 既定は消音なので、つないで
      // いるだけのタブを数えると通知が無音へ向かって「喋った」ことになる。
      const audio = c.req.query('audio') === '1';

      const unsubscribe = subscribeAvatarEvents(
        deps,
        (event) => {
          // 書き込みは待たない。**遅い購読者のために読み上げを止めない**
          // （port の約束どおり投げっぱなし）。
          //
          // **書けなかったらそこで畳む。** 閉じたタブは次の書き込みが
          // 失敗するまで検知されない。放っておくと、音を鳴らせると名乗った
          // まま消えたタブが出口として数えられ続け、その間の通知が無音へ
          // 向かって「喋った」ことになる（→ D-40 の 2）。
          void stream
            .writeSSE({ event: event.kind, data: JSON.stringify(event) })
            .catch(() => finish());
        },
        { audio, onClose: () => finish() },
      );

      const keepAlive = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: '' }).catch(() => finish());
      }, KEEP_ALIVE_INTERVAL_MS);

      try {
        await closed;
      } finally {
        clearInterval(keepAlive);
        unsubscribe();
      }
    });

  /**
   * ブラウザで鳴らす音（F-23）。**Discord へ流したのと同じ合成結果**。
   *
   * **ここは会話の中身そのものを返す**（→ D-39 の 6）。ID は推測できない値
   * （UUID）で寿命も短いが、**実際の守りは ingress の認証**（D-37）。
   *
   * `no-store` にしてあるのは、間に立つものに会話の音を持たせないため。
   *
   * **ID はクエリで受ける。** Flue のチャンネルルーターは**パスを文字列一致
   * で引く**ので、`/speech/:id` のようなパラメータは一生マッチしない
   * （実機で 404 になって気付いた）。
   */
  const getSpeechAudio: ChannelRouteDefinition['handler'] = (c) => {
    const wav = avatarSpeechAudio(deps, c.req.query('id') ?? '');
    if (!wav) {
      // 消えているのは異常ではない（溜めているのは直近だけ）。
      return c.json({ error: 'その音はもう残っていません。' }, 404);
    }
    return c.body(wav as unknown as ArrayBuffer, 200, {
      'content-type': SPEECH_CONTENT_TYPE,
      'cache-control': 'no-store',
    });
  };

  return [
    { method: 'GET', path: '/avatar/config', handler: getConfig },
    { method: 'GET', path: '/avatar/model', handler: getModel },
    { method: 'GET', path: '/avatar/gesture', handler: getGestureMotion },
    { method: 'GET', path: '/avatar/events', handler: getEvents },
    { method: 'GET', path: '/avatar/speech', handler: getSpeechAudio },
  ];
}
