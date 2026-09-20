import {
  type ChannelRouteDefinition,
  createChannelRouter,
} from '@flue/runtime';
import {
  type AvatarDependencies,
  avatarModel,
  avatarView,
} from '../../application/avatar.ts';

/** VRM の media type。glTF バイナリと同じ形式。 */
const VRM_CONTENT_TYPE = 'model/gltf-binary';

/**
 * アバターの表示に要るもの（F-20）。
 *
 * **この 2 本に認証は無い**（→ D-36 の 4、D-37）。守るのは ingress 側で、
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

  return createChannelRouter([
    { method: 'GET', path: '/avatar/config', handler: getConfig },
    { method: 'GET', path: '/avatar/model', handler: getModel },
  ]);
}
