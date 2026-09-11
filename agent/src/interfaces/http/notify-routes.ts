import {
  type ChannelRouteDefinition,
  createChannelRouter,
} from '@flue/runtime';
import * as v from 'valibot';
import type { NotifyDependencies } from '../../application/notify.ts';
import {
  lastNotificationAcceptedAt,
  notify,
} from '../../application/notify.ts';
import {
  currentVoiceChannel,
  type VoiceSessionDependencies,
} from '../../application/voice-session.ts';
import { createNotifyAuthenticator, type NotifyToken } from './notify-auth.ts';

/** 読み上げる本文の上限。これ以上は通知ではなく文書で、VC で流す意味がない。 */
const MAX_BODY_LENGTH = 2000;

const NotifyRequestSchema = v.object({
  text: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(MAX_BODY_LENGTH),
  ),
});

export interface NotifyRoutesInput {
  tokens: readonly NotifyToken[];
  notifyDependencies: NotifyDependencies;
  voiceDependencies: VoiceSessionDependencies;
  log: {
    warn(context: Record<string, unknown>, message: string): void;
  };
}

/**
 * 外部通知の受け口（F-15）と状態確認。
 *
 * 応答は「受理したか」だけを返し、読み上げ完了までブロックしない。
 * 状態にもチャンネル ID が乗るので、同じ認証をかける。
 */
export function createNotifyRouter(input: NotifyRoutesInput) {
  const authenticate = createNotifyAuthenticator(input.tokens);

  function sourceOf(
    authorization: string | undefined,
    path: string,
  ): string | undefined {
    const source = authenticate(authorization);
    if (!source) {
      input.log.warn(
        { path },
        'Rejected an unauthenticated request to the notify API',
      );
    }
    return source;
  }

  const postNotify: ChannelRouteDefinition['handler'] = async (c) => {
    const source = sourceOf(c.req.header('authorization'), '/notify');
    if (!source) return c.json({ error: 'unauthorized' }, 401);

    const parsed = v.safeParse(
      NotifyRequestSchema,
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      input.log.warn({ source }, 'Rejected a malformed notification payload');
      return c.json({ error: v.summarize(parsed.issues) }, 400);
    }

    const disposition = await notify(input.notifyDependencies, {
      source,
      body: parsed.output.text,
    });
    return c.json({ accepted: true, disposition }, 202);
  };

  const getStatus: ChannelRouteDefinition['handler'] = (c) => {
    const source = sourceOf(c.req.header('authorization'), '/voice/status');
    if (!source) return c.json({ error: 'unauthorized' }, 401);

    const channel = currentVoiceChannel(input.voiceDependencies);
    return c.json({
      connected: channel !== undefined,
      guildId: channel?.guildId ?? null,
      channelId: channel?.channelId ?? null,
      lastNotifyAt: lastNotificationAcceptedAt() ?? null,
    });
  };

  return createChannelRouter([
    { method: 'POST', path: '/notify', handler: postNotify },
    { method: 'GET', path: '/voice/status', handler: getStatus },
  ]);
}
