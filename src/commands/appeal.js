import { SlashCommandBuilder, EmbedBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { submitAppeal, getPendingAppeals, getAppeal, approveAppeal, denyAppeal } from '../services/appeals.js';
import { isBlacklisted, removeFromBlacklist } from '../services/blacklist.js';
import { clearWarnings } from '../services/warnings.js';
import { isWhitelisted } from '../utils/whitelist.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('appeal')
  .setDescription('Ban appeal system')
  .setContexts(0)
  .addSubcommand((sub) =>
    sub.setName('submit')
      .setDescription('Submit a ban appeal (if you are blacklisted)')
  )
  .addSubcommand((sub) =>
    sub.setName('list')
      .setDescription('View pending ban appeals (Staff only)')
  )
  .addSubcommand((sub) =>
    sub.setName('approve')
      .setDescription('Approve a ban appeal (Staff only)')
      .addIntegerOption((o) => o.setName('id').setDescription('Appeal ID').setRequired(true))
      .addStringOption((o) => o.setName('note').setDescription('Note for the user').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub.setName('deny')
      .setDescription('Deny a ban appeal (Staff only)')
      .addIntegerOption((o) => o.setName('id').setDescription('Appeal ID').setRequired(true))
      .addStringOption((o) => o.setName('note').setDescription('Reason for denial').setRequired(false))
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const sub = interaction.options.getSubcommand();

  if (sub === 'submit') {
    if (!isBlacklisted(interaction.user.id)) {
      return interaction.reply({ content: 'You are not blacklisted — no appeal needed!', flags: MessageFlags.Ephemeral });
    }

    // Show modal for appeal reason
    const modal = new ModalBuilder()
      .setCustomId('appeal_modal')
      .setTitle('Ban Appeal');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('appeal_reason')
          .setLabel('Why should your ban be lifted?')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setPlaceholder('Explain why you believe your blacklist should be removed...')
          .setMinLength(20)
          .setMaxLength(1000)
      )
    );
    await interaction.showModal(modal);
    return;
  }

  if (sub === 'list') {
    if (!isWhitelisted(interaction.user.id)) {
      return interaction.reply({ content: 'Only whitelisted staff can view appeals.', flags: MessageFlags.Ephemeral });
    }
    const pending = getPendingAppeals();
    if (pending.length === 0) return interaction.reply({ content: 'No pending appeals.', flags: MessageFlags.Ephemeral });

    const lines = pending.map((a) => {
      const date = new Date(a.created_at + 'Z');
      return `**#${a.id}** — <@${a.user_id}> • <t:${Math.floor(date.getTime() / 1000)}:R>\n> ${a.reason.slice(0, 100)}${a.reason.length > 100 ? '...' : ''}`;
    });
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('📋 Pending Ban Appeals')
      .setDescription(lines.join('\n\n'))
      .setFooter({ text: `${pending.length} pending • Use /appeal approve or /appeal deny` })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'approve') {
    if (!isWhitelisted(interaction.user.id)) {
      return interaction.reply({ content: 'Only whitelisted staff can approve appeals.', flags: MessageFlags.Ephemeral });
    }
    const id = interaction.options.getInteger('id');
    const note = interaction.options.getString('note');
    const appeal = getAppeal(id);
    if (!appeal) return interaction.reply({ content: `Appeal #${id} not found.`, flags: MessageFlags.Ephemeral });
    if (appeal.status !== 'pending') return interaction.reply({ content: `Appeal #${id} already ${appeal.status}.`, flags: MessageFlags.Ephemeral });

    approveAppeal(id, interaction.user.id, note);
    removeFromBlacklist(appeal.user_id);
    clearWarnings(appeal.user_id);

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅ Appeal Approved')
      .setDescription(`<@${appeal.user_id}>'s ban appeal **#${id}** has been approved by <@${interaction.user.id}>.`)
      .addFields(
        { name: 'Appeal Reason', value: appeal.reason.slice(0, 200), inline: false },
        { name: 'Staff Note', value: note || '*None*', inline: false },
      )
      .setFooter({ text: 'User has been unblacklisted and warnings cleared' })
      .setTimestamp();
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

    // DM the user
    try {
      const user = await interaction.client.users.fetch(appeal.user_id).catch(() => null);
      if (user) {
        await user.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x57f287)
              .setTitle('✅ Your Ban Appeal Was Approved!')
              .setDescription([
                'Your blacklist has been lifted and your warnings have been cleared.',
                'You can now use the activation service again.',
                '',
                note ? `**Staff note:** ${note}` : '',
                '',
                '> Please follow the rules to avoid being blacklisted again.',
              ].filter(Boolean).join('\n'))
              .setTimestamp(),
          ],
        }).catch(() => {});
      }
    } catch {}
    return;
  }

  if (sub === 'deny') {
    if (!isWhitelisted(interaction.user.id)) {
      return interaction.reply({ content: 'Only whitelisted staff can deny appeals.', flags: MessageFlags.Ephemeral });
    }
    const id = interaction.options.getInteger('id');
    const note = interaction.options.getString('note');
    const appeal = getAppeal(id);
    if (!appeal) return interaction.reply({ content: `Appeal #${id} not found.`, flags: MessageFlags.Ephemeral });
    if (appeal.status !== 'pending') return interaction.reply({ content: `Appeal #${id} already ${appeal.status}.`, flags: MessageFlags.Ephemeral });

    denyAppeal(id, interaction.user.id, note);

    await interaction.reply({
      content: `❌ Appeal **#${id}** from <@${appeal.user_id}> has been denied.${note ? ` Reason: ${note}` : ''}`,
      flags: MessageFlags.Ephemeral,
    });

    // DM the user
    try {
      const user = await interaction.client.users.fetch(appeal.user_id).catch(() => null);
      if (user) {
        await user.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xed4245)
              .setTitle('❌ Your Ban Appeal Was Denied')
              .setDescription([
                'Your appeal has been reviewed and denied.',
                note ? `**Reason:** ${note}` : '',
                '',
                'You may submit a new appeal later.',
              ].filter(Boolean).join('\n'))
              .setTimestamp(),
          ],
        }).catch(() => {});
      }
    } catch {}
    return;
  }
}

/**
 * Handle the appeal modal submission.
 */
export async function handleAppealModal(interaction) {
  if (!interaction.isModalSubmit() || interaction.customId !== 'appeal_modal') return false;

  const reason = interaction.fields.getTextInputValue('appeal_reason');
  const result = submitAppeal(interaction.user.id, reason);

  if (!result.ok) {
    await interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
    return true;
  }

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('📝 Appeal Submitted')
    .setDescription([
      `Your ban appeal **#${result.appealId}** has been submitted.`,
      '',
      'A staff member will review it. You\'ll receive a DM when a decision is made.',
      '',
      `**Your reason:**\n> ${reason.slice(0, 300)}`,
    ].join('\n'))
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  return true;
}
