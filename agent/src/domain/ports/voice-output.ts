export interface VoiceChannelRef {
  readonly guildId: string;
  readonly channelId: string;
}

/**
 * 音声の出力先（F-11, F-12）。実装は Discord VC の 1 つだけだが、
 * application はどこへ出しているかを知らない。
 *
 * 同時接続は 1 つ。複数の VC に同時にいると「通知をどちらで読むか」が
 * 決まらなくなる（既存 discord-vc の `destroyAll()` と同じ方針）。
 */
export interface VoiceOutput {
  join(ref: VoiceChannelRef): Promise<void>;
  /** 接続していたら破棄して true。 */
  leave(): boolean;
  /** 再生可能な状態の接続先。未接続なら undefined。 */
  current(): VoiceChannelRef | undefined;
  /** 再生が終わるまで待つ。呼んでよいのは application/speech.ts だけ（INV-5）。 */
  play(pcm: Uint8Array): Promise<void>;
}
