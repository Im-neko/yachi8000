import {
  ChannelType,
  type ChatInputCommandInteraction,
  type Client,
  Events,
  type Guild,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type { PersonaDependencies } from '../../application/persona.ts';
import type { SkillDependencies } from '../../application/skill.ts';
import {
  joinVoice,
  leaveVoice,
  type VoiceSessionDependencies,
} from '../../application/voice-session.ts';
import { logger } from '../../observability/logger.ts';
import {
  handlePersonaAutocomplete,
  handlePersonaCommand,
  PERSONA_COMMAND,
} from './persona-commands.ts';
import {
  handleSkillAutocomplete,
  handleSkillCommand,
  SKILL_COMMAND,
} from './skill-commands.ts';

/**
 * ギルド単位で登録する（F-11）。
 *
 * グローバル登録は反映に時間がかかるうえ、両方に登録するとコマンドが
 * 二重に出る。参加しているギルドへ登録すれば即時に反映される。
 */
const COMMANDS = [
  new SlashCommandBuilder()
    .setName('vc-join')
    .setDescription('ボイスチャンネルに参加します')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('参加先。省略すると、あなたが今いるチャンネル')
        // ステージは対象外。Bot は聴衆として入るだけで登壇できず、
        // エラーも出ないまま無音になる。
        .addChannelTypes(ChannelType.GuildVoice),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('vc-leave')
    .setDescription('ボイスチャンネルから退出します')
    .toJSON(),
  SKILL_COMMAND,
  PERSONA_COMMAND,
];

async function register(guild: Guild): Promise<void> {
  await guild.commands.set(COMMANDS);
  logger.info(
    { guildId: guild.id, guild: guild.name },
    'Registered slash commands',
  );
}

async function handleJoin(
  interaction: ChatInputCommandInteraction,
  deps: VoiceSessionDependencies,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: 'このコマンドはサーバ内で実行してください。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const requested = interaction.options.getChannel('channel');
  const member = await guild.members.fetch(interaction.user.id);
  const channel = requested ?? member.voice.channel;
  if (!channel) {
    await interaction.reply({
      content:
        '参加先が分かりません。ボイスチャンネルに入ってから実行するか、channel を指定してください。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (channel.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: 'ステージチャンネルには参加できません。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  await joinVoice(deps, { guildId: guild.id, channelId: channel.id });
  await interaction.editReply(`<#${channel.id}> に参加しました。`);
}

async function handleLeave(
  interaction: ChatInputCommandInteraction,
  deps: VoiceSessionDependencies,
): Promise<void> {
  const left = leaveVoice(deps);
  await interaction.reply({
    content: left ? '退出しました。' : 'ボイスチャンネルに参加していません。',
    flags: left ? undefined : MessageFlags.Ephemeral,
  });
}

export interface SlashCommandDependencies {
  voice: VoiceSessionDependencies;
  skills: SkillDependencies;
  persona: PersonaDependencies;
}

/** コマンド名から、そのコマンドを捌く関数を引く。 */
function routeCommand(
  interaction: ChatInputCommandInteraction,
  deps: SlashCommandDependencies,
): Promise<void> | undefined {
  switch (interaction.commandName) {
    case 'vc-join':
      return handleJoin(interaction, deps.voice);
    case 'vc-leave':
      return handleLeave(interaction, deps.voice);
    case 'skill':
      return handleSkillCommand(interaction, deps.skills);
    case 'persona':
      return handlePersonaCommand(interaction, deps.persona);
    default:
      return undefined;
  }
}

export async function registerSlashCommands(
  client: Client<true>,
  deps: SlashCommandDependencies,
): Promise<void> {
  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isAutocomplete()) {
      const responding =
        interaction.commandName === 'skill'
          ? handleSkillAutocomplete(interaction, deps.skills)
          : interaction.commandName === 'persona'
            ? handlePersonaAutocomplete(interaction, deps.persona)
            : undefined;
      // 補完に失敗しても操作は続けられる（手で ID を貼れる）。落とさない。
      responding?.catch((error) => {
        logger.warn(
          { err: error, command: interaction.commandName },
          'Autocomplete failed',
        );
      });
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const handling = routeCommand(interaction, deps);
    if (!handling) return;

    handling.catch(async (error) => {
      logger.error(
        { err: error, command: interaction.commandName },
        'Slash command failed',
      );
      const content = `コマンドに失敗しました: ${(error as Error).message}`;
      await (interaction.deferred || interaction.replied
        ? interaction.editReply(content)
        : interaction.reply({ content, flags: MessageFlags.Ephemeral })
      ).catch(() => undefined);
    });
  });

  // 起動後に招待されたサーバにも生やす。
  client.on(Events.GuildCreate, (guild) => {
    register(guild).catch((error) => {
      logger.error(
        { err: error, guildId: guild.id },
        'Failed to register slash commands',
      );
    });
  });

  await Promise.all(client.guilds.cache.map((guild) => register(guild)));
}
