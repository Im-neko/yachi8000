import {
  type ChannelRouteDefinition,
  createChannelRouter,
} from '@flue/runtime';
import * as v from 'valibot';
import { runAgentTurn } from '../../agents/run-turn.ts';
import {
  joinVoice,
  leaveVoice,
  type VoiceSessionDependencies,
} from '../../application/voice-session.ts';
import type { ConversationId } from '../../domain/conversation.ts';
import { debugSpeakerId } from '../../domain/speaker.ts';

const ChatRequestSchema = v.object({
  conversationId: v.optional(v.pipe(v.string(), v.minLength(1)), 'debug-local'),
  text: v.pipe(v.string(), v.minLength(1)),
});

const JoinRequestSchema = v.object({
  guildId: v.pipe(v.string(), v.minLength(1)),
  channelId: v.pipe(v.string(), v.minLength(1)),
});

/**
 * Discord のスラッシュコマンドを経由せずに検証するための入口。**DEBUG_MODE
 * 限定**で、app.ts はこのルータを DEBUG_MODE=true のときだけマウントする
 * （production との併用は env.ts が起動時に拒否する）。
 */
export function createDebugRouter(voice: VoiceSessionDependencies) {
  const chat: ChannelRouteDefinition['handler'] = async (c) => {
    const parsed = v.safeParse(ChatRequestSchema, await c.req.json());
    if (!parsed.success) {
      return c.json({ error: v.summarize(parsed.issues) }, 400);
    }

    const reply = await runAgentTurn({
      conversationId: parsed.output.conversationId as ConversationId,
      message: {
        kind: 'signal',
        type: 'debug.message',
        body: parsed.output.text,
        attributes: {
          speakerId: debugSpeakerId(),
          speakerName: 'デバッグ',
        },
      },
    });
    return c.json({ reply: reply ?? null });
  };

  const vcJoin: ChannelRouteDefinition['handler'] = async (c) => {
    const parsed = v.safeParse(JoinRequestSchema, await c.req.json());
    if (!parsed.success) {
      return c.json({ error: v.summarize(parsed.issues) }, 400);
    }
    await joinVoice(voice, parsed.output);
    return c.json({ joined: true });
  };

  const vcLeave: ChannelRouteDefinition['handler'] = (c) =>
    c.json({ left: leaveVoice(voice) });

  return createChannelRouter([
    { method: 'POST', path: '/chat', handler: chat },
    { method: 'POST', path: '/vc-join', handler: vcJoin },
    { method: 'POST', path: '/vc-leave', handler: vcLeave },
  ]);
}
