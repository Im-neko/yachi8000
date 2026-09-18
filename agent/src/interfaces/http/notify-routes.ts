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
/** 肩書きの上限。読み上げの冒頭に入るので、1 息で読める長さに抑える。 */
const MAX_ROLE_LENGTH = 40;
/** 宛先の名前（F-15）。settings 側の `notification.channels` のキーと同じ形。 */
const CHANNEL_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

const NotifyRequestSchema = v.object({
  text: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(MAX_BODY_LENGTH),
  ),
  /**
   * 送信元が何をしている人（プロセス）かの申告（F-15）。
   *
   * 並列に動かしていると「おわりました」だけでは何が終わったか分からない。
   * ただしこれは**本文と同じ非信頼データ**で、`source` の代わりにはならない
   * —— 送信元の同一性はトークンからしか決まらない（F-18）。
   */
  role: v.optional(
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_ROLE_LENGTH)),
  ),
  /**
   * 残しておきたい通知の宛先（F-15, D-31）。
   *
   * **設定に置かれた名前**であってチャンネル ID ではない。ID を受けると、
   * 読み上げのために配ったトークンが「Bot の見えるどこへでも書ける」権限に
   * 化ける。名前の解決先は運用者が settings に置く。
   */
  channel: v.optional(v.pipe(v.string(), v.trim(), v.regex(CHANNEL_NAME))),
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
      role: parsed.output.role,
      channel: parsed.output.channel,
    });
    // 設定に無い宛先は配信の失敗ではなく送信元の誤り。受理したことにすると、
    // 名前を間違えたまま黙って消え続ける（→ D-31）。
    if (disposition === 'unknown-channel') {
      return c.json({ error: 'unknown channel' }, 400);
    }
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
