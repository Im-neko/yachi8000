import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import {
  approveSkill,
  disableSkill,
  listSkills,
  rejectAllPendingSkills,
  rejectSkill,
  type SkillDependencies,
} from '../../application/skill.ts';
import type { SkillCandidate, SkillStatus } from '../../domain/skill.ts';
import { tenantIdOfInteraction } from './tenant.ts';

/** Discord のオートコンプリートが返せる候補数の上限。 */
const AUTOCOMPLETE_LIMIT = 25;

/**
 * スキルの棚卸しコマンド（F-41, F-43）。
 *
 * **サーバの管理権限を要求する**（`ManageGuild`）。人格・口調を変えるスキルを
 * 有効化できる操作なので、サーバの誰でも押せる状態にはしない。Discord 側の
 * 機構だけで済ませ、独自の認可は持たない。
 */
export const SKILL_COMMAND = new SlashCommandBuilder()
  .setName('skill')
  .setDescription('学習したスキルの確認と承認')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('スキルを一覧します')
      .addStringOption((option) =>
        option
          .setName('status')
          .setDescription('絞り込む状態。省略すると保留中')
          .addChoices(
            { name: '保留中', value: 'pending' },
            { name: '承認済み', value: 'approved' },
            { name: '却下済み', value: 'rejected' },
            { name: '無効化済み', value: 'disabled' },
            { name: 'すべて', value: 'all' },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('approve')
      .setDescription('スキルを承認します（次のターン以降に効きます）')
      .addStringOption((option) =>
        option
          .setName('skill')
          .setDescription('承認するスキル')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('reject')
      .setDescription('保留中のスキルを却下します')
      .addStringOption((option) =>
        option
          .setName('skill')
          .setDescription('却下するスキル')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('reject-all')
      .setDescription('保留中のスキルをすべて却下します'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('disable')
      .setDescription('承認済みのスキルを無効化します')
      .addStringOption((option) =>
        option
          .setName('skill')
          .setDescription('無効化するスキル')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .toJSON();

const ALL_STATUSES: readonly SkillStatus[] = [
  'pending',
  'approved',
  'rejected',
  'disabled',
];

/** サブコマンドごとに、オートコンプリートで出す状態。 */
const AUTOCOMPLETE_STATUSES: Record<string, readonly SkillStatus[]> = {
  approve: ['pending', 'disabled'],
  reject: ['pending'],
  disable: ['approved'],
};

function formatCandidate(candidate: SkillCandidate): string {
  return [
    `**${candidate.name}** \`${candidate.status}\` \`${candidate.kind}\``,
    candidate.description,
    `ID: \`${candidate.id}\``,
  ].join('\n');
}

export async function handleSkillCommand(
  interaction: ChatInputCommandInteraction,
  deps: SkillDependencies,
): Promise<void> {
  const tenantId = tenantIdOfInteraction(interaction);
  if (!tenantId) {
    await interaction.reply({
      content: 'このコマンドはサーバ内で実行してください。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'list') {
    const requested = interaction.options.getString('status') ?? 'pending';
    const statuses =
      requested === 'all' ? ALL_STATUSES : [requested as SkillStatus];
    const skills = listSkills(deps, tenantId, statuses);
    await interaction.reply({
      content:
        skills.length === 0
          ? '該当するスキルはありません。'
          : skills.map(formatCandidate).join('\n\n').slice(0, 1900),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'reject-all') {
    const rejected = rejectAllPendingSkills(deps, tenantId);
    await interaction.reply({
      content: `保留中のスキルを ${rejected} 件却下しました。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const id = interaction.options.getString('skill', true);
  const action =
    subcommand === 'approve'
      ? approveSkill
      : subcommand === 'reject'
        ? rejectSkill
        : subcommand === 'disable'
          ? disableSkill
          : undefined;
  if (!action) {
    await interaction.reply({
      content: `未知のサブコマンドです: ${subcommand}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const result = action(deps, { tenantId, id });
  if (!result) {
    await interaction.reply({
      content:
        'その操作ができる状態のスキルが見つかりませんでした。`/skill list status:すべて` で今の状態を確認してください。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const note =
    result.status === 'approved' ? '次のターン以降の応答から効きます。' : '';
  await interaction.reply({
    content: `**${result.name}** を \`${result.status}\` にしました。${note}`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * ID を手で打たせない（UUID なので現実的でない）。サブコマンドが動かせる
 * 状態のものだけを出すので、そもそも通らない組み合わせが選べない。
 */
export async function handleSkillAutocomplete(
  interaction: AutocompleteInteraction,
  deps: SkillDependencies,
): Promise<void> {
  const tenantId = tenantIdOfInteraction(interaction);
  if (!tenantId) {
    await interaction.respond([]);
    return;
  }

  const statuses =
    AUTOCOMPLETE_STATUSES[interaction.options.getSubcommand()] ?? ALL_STATUSES;
  const typed = interaction.options.getFocused().toLowerCase();
  const choices = listSkills(deps, tenantId, statuses)
    .filter((skill) => skill.name.toLowerCase().includes(typed))
    .slice(0, AUTOCOMPLETE_LIMIT)
    .map((skill) => ({
      name: `${skill.name} (${skill.kind})`.slice(0, 100),
      value: skill.id,
    }));
  await interaction.respond(choices);
}
