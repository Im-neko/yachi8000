import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import {
  isPersonaLocked,
  listPersonaChanges,
  type PersonaDependencies,
  resetPersona,
  revertPersonaChange,
} from '../../application/persona.ts';
import type { PersonaDiffRecord } from '../../domain/ports/persona-diff-store.ts';
import { tenantIdOfInteraction } from './tenant.ts';

const AUTOCOMPLETE_LIMIT = 25;

/**
 * 人格の変化を見て戻すコマンド（F-33）。
 *
 * スキルと同じく**サーバの管理権限**を要求する。既定の人格そのもの（設定
 * ファイル）はここからは触らない —— 巻き戻しはランタイム状態を捨てるだけで
 * 成立する（D-12）。
 */
export const PERSONA_COMMAND = new SlashCommandBuilder()
  .setName('persona')
  .setDescription('会話を通じた人格の変化の確認と巻き戻し')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('人格の変化を新しい順に一覧します'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('revert')
      .setDescription('人格の変化を 1 件巻き戻します')
      .addStringOption((option) =>
        option
          .setName('change')
          .setDescription('巻き戻す変化')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('reset')
      .setDescription('設定ファイルの既定の人格まで一括で巻き戻します'),
  )
  .toJSON();

function formatChange(change: PersonaDiffRecord): string {
  const recordedAt = new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Tokyo',
  }).format(new Date(change.recordedAt));
  const state = change.revertedAt ? '巻き戻し済み' : '有効';
  return [
    `\`${state}\` ${recordedAt}`,
    `- 指示: ${change.instruction}`,
    `- 契機: ${change.reason}`,
    `- ID: \`${change.id}\``,
  ].join('\n');
}

export async function handlePersonaCommand(
  interaction: ChatInputCommandInteraction,
  deps: PersonaDependencies,
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
    const changes = listPersonaChanges(deps, tenantId);
    const lock = isPersonaLocked(deps)
      ? '\n\n**固定モードが有効です。** 記録は続いていますが、応答には反映されていません。'
      : '';
    await interaction.reply({
      content:
        changes.length === 0
          ? `記録された人格の変化はありません。${lock}`
          : `${changes.map(formatChange).join('\n\n').slice(0, 1800)}${lock}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'reset') {
    const reverted = resetPersona(deps, tenantId);
    await interaction.reply({
      content: `人格の変化を ${reverted} 件巻き戻し、設定ファイルの既定の人格に戻しました。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'revert') {
    const id = interaction.options.getString('change', true);
    const reverted = revertPersonaChange(deps, { tenantId, id });
    await interaction.reply({
      content: reverted
        ? '巻き戻しました。次のターン以降の応答から外れます。'
        : 'その変化は見つかりませんでした（既に巻き戻し済みかもしれません）。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: `未知のサブコマンドです: ${subcommand}`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handlePersonaAutocomplete(
  interaction: AutocompleteInteraction,
  deps: PersonaDependencies,
): Promise<void> {
  const tenantId = tenantIdOfInteraction(interaction);
  if (!tenantId) {
    await interaction.respond([]);
    return;
  }

  const typed = interaction.options.getFocused().toLowerCase();
  const choices = listPersonaChanges(deps, tenantId)
    .filter((change) => change.revertedAt === undefined)
    .filter((change) => change.instruction.toLowerCase().includes(typed))
    .slice(0, AUTOCOMPLETE_LIMIT)
    .map((change) => ({
      name: change.instruction.slice(0, 100),
      value: change.id,
    }));
  await interaction.respond(choices);
}
