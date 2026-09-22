import type { ChannelRouteDefinition } from '@flue/runtime';
import * as v from 'valibot';
import type { PresenceService } from '../../application/presence.ts';

const PresenceRequestSchema = v.object({
  state: v.picklist(['present', 'absent', 'unknown']),
});

/**
 * 報告者を分ける鍵。**認証基盤が通す利用者名**（→ D-37）。
 *
 * **これは認証ではない。** この入口は forward auth の内側にあり、届いた
 * 時点で認証は済んでいる。ここでやっているのは「どの端末の報告か」を
 * 分けることだけなので、名前が取れなければまとめて 1 つとして扱う
 * （開発時はヘッダが無い）。
 */
const USER_HEADER = 'x-authentik-username';

/**
 * カメラの判定を受け取る（F-26、→ D-46）。
 *
 * **映像は受け取らない。** 上がってくるのは 3 値だけで、判定はブラウザの
 * 中で終わっている。**素通しの `publicPaths` には載せない** —— 載せると、
 * 外から「誰もいない」と言い続けるだけで読み上げを止められる。
 */
export function createPresenceRoutes(
  presence: PresenceService,
): ChannelRouteDefinition[] {
  const postPresence: ChannelRouteDefinition['handler'] = async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'JSON として読めませんでした。' }, 400);
    }

    const parsed = v.safeParse(PresenceRequestSchema, body);
    if (!parsed.success) {
      return c.json({ error: v.summarize(parsed.issues) }, 400);
    }

    presence.report(
      c.req.header(USER_HEADER) ?? 'anonymous',
      parsed.output.state,
    );
    return c.json({ presence: presence.current() });
  };

  return [{ method: 'POST', path: '/presence', handler: postPresence }];
}
