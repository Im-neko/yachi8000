import { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  getVoiceConnections,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  type VoiceConnection,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import type { Client } from 'discord.js';
import type {
  VoiceChannelRef,
  VoiceOutput,
} from '../../domain/ports/voice-output.ts';
import { logger } from '../../observability/logger.ts';

/** 48000Hz / 2ch / 16bit LE。`StreamType.Raw` が期待する形。 */
const BYTES_PER_SECOND = 48000 * 2 * 2;

const READY_TIMEOUT_MS = 30_000;
/** 切断後、チャンネル移動かどうかを見極めるための猶予。 */
const RECONNECT_GRACE_MS = 5_000;
/** 再生が終わらないまま止まるのを検知する余裕。音声の長さに上乗せする。 */
const PLAYBACK_SLACK_MS = 10_000;

/**
 * Discord VC への音声出力（F-11, F-12）。
 *
 * 接続は常に 1 つ。`AudioPlayer` も 1 つで、再生の直列化は上位の
 * 再生キュー（application/speech.ts）が持つ（INV-5）。
 */
export function createDiscordVoiceOutput(client: Client): VoiceOutput {
  const player = createAudioPlayer({
    // 既定の Pause は、購読者がいないと再生が止まったまま Idle にならず、
    // 再生ループが永久に待つ。購読が切れたら捨てる。
    behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
  });

  player.on('error', (error) => {
    logger.error({ err: error }, 'Audio player error');
  });

  function destroy(connection: VoiceConnection): boolean {
    if (connection.state.status === VoiceConnectionStatus.Destroyed)
      return false;
    connection.destroy();
    return true;
  }

  /**
   * 残った接続は Discord 側で切断しても `@discordjs/voice` が自動再接続する。
   * 新しく参加する前に必ず破棄する（出所: discord-vc の `destroyAll()`）。
   */
  function destroyAll(): number {
    let count = 0;
    for (const [guildId, connection] of getVoiceConnections()) {
      if (destroy(connection)) {
        logger.debug({ guildId }, 'Destroyed an existing voice connection');
        count += 1;
      }
    }
    return count;
  }

  function readyConnection(): VoiceConnection | undefined {
    for (const [, connection] of getVoiceConnections()) {
      if (connection.state.status === VoiceConnectionStatus.Ready)
        return connection;
    }
    return undefined;
  }

  return {
    async join(ref: VoiceChannelRef): Promise<void> {
      const guild = await client.guilds.fetch(ref.guildId);
      const channel = await guild.channels.fetch(ref.channelId);
      if (!channel?.isVoiceBased()) {
        throw new Error(
          `チャンネル ${ref.channelId} はボイスチャンネルではありません。`,
        );
      }

      destroyAll();

      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
      });
      connection.subscribe(player);

      connection.on('stateChange', (oldState, newState) => {
        logger.debug(
          { guildId: guild.id, from: oldState.status, to: newState.status },
          'Voice connection state changed',
        );
      });

      // 切断されたら破棄する。破棄しないと自動再接続で戻ってきてしまい、
      // Discord 側から追い出せない。ただしチャンネル移動も一旦 Disconnected を
      // 経由するので、短時間で再接続へ向かう場合だけは自動再接続に任せる。
      connection.on(VoiceConnectionStatus.Disconnected, () => {
        Promise.race([
          entersState(
            connection,
            VoiceConnectionStatus.Signalling,
            RECONNECT_GRACE_MS,
          ),
          entersState(
            connection,
            VoiceConnectionStatus.Connecting,
            RECONNECT_GRACE_MS,
          ),
        ]).then(
          () =>
            logger.info(
              { guildId: guild.id },
              'Voice connection is moving channels',
            ),
          () => {
            logger.info(
              { guildId: guild.id },
              'Voice connection disconnected — destroying',
            );
            destroy(connection);
          },
        );
      });

      await entersState(
        connection,
        VoiceConnectionStatus.Ready,
        READY_TIMEOUT_MS,
      );
    },

    leave(): boolean {
      const connection = readyConnection();
      if (!connection) return destroyAll() > 0;
      return destroy(
        getVoiceConnection(connection.joinConfig.guildId) ?? connection,
      );
    },

    current(): VoiceChannelRef | undefined {
      const connection = readyConnection();
      const channelId = connection?.joinConfig.channelId;
      if (!connection || !channelId) return undefined;
      return { guildId: connection.joinConfig.guildId, channelId };
    },

    async play(pcm: Uint8Array): Promise<void> {
      const resource = createAudioResource(Readable.from([Buffer.from(pcm)]), {
        inputType: StreamType.Raw,
      });
      player.play(resource);

      const timeoutMs =
        (pcm.byteLength / BYTES_PER_SECOND) * 1000 + PLAYBACK_SLACK_MS;
      await entersState(player, AudioPlayerStatus.Idle, timeoutMs);
    },
  };
}
