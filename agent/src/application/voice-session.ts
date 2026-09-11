import type {
  VoiceChannelRef,
  VoiceOutput,
} from '../domain/ports/voice-output.ts';

export interface VoiceSessionDependencies {
  voice: VoiceOutput;
  log: {
    info(context: Record<string, unknown>, message: string): void;
  };
}

/**
 * VC への参加・退出（F-11）。
 *
 * 同時接続は 1 つに保つ。どの VC で通知を読むか（F-15）はこの 1 接続で
 * 決まるので、経路を増やすと宛先の決定が非決定になる。
 */
export async function joinVoice(
  deps: VoiceSessionDependencies,
  ref: VoiceChannelRef,
): Promise<void> {
  await deps.voice.join(ref);
  deps.log.info({ ...ref }, 'Joined a voice channel');
}

export function leaveVoice(deps: VoiceSessionDependencies): boolean {
  const left = deps.voice.leave();
  deps.log.info({ left }, 'Left the voice channel');
  return left;
}

export function currentVoiceChannel(
  deps: VoiceSessionDependencies,
): VoiceChannelRef | undefined {
  return deps.voice.current();
}
