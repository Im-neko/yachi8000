import type { ChannelRouteDefinition } from '@flue/runtime';
import {
  resolveWebSpeaker,
  type VoiceInputDependencies,
} from '../../application/voice-input.ts';

/**
 * 認証基盤が通す利用者名（→ D-37）。**認証ではなく、名乗りを読むだけ。**
 */
const USER_HEADER = 'x-authentik-username';

/**
 * 「いま自分は誰として通っているか」を返す（→ D-45）。
 *
 * **対応表は人が手で書く**（設定 UI からは変えられない → D-44）。書くには
 * 認証基盤での自分の利用者名が要るが、**それを知る手立てがどこにも無かった。**
 * アプリは毎回ヘッダで受け取っているので、そのまま見せる。
 *
 * **自分の名前を自分に返すだけ**なので、他人の情報は出ない。
 */
export function createMeRoutes(
  deps: VoiceInputDependencies,
): ChannelRouteDefinition[] {
  const getMe: ChannelRouteDefinition['handler'] = (c) => {
    const username = c.req.header(USER_HEADER);
    const speaker = resolveWebSpeaker(deps, username);
    return c.json({
      username: username ?? null,
      speakerId: speaker?.speakerId ?? null,
    });
  };

  return [{ method: 'GET', path: '/me', handler: getMe }];
}
