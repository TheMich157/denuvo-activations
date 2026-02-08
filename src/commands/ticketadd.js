import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { getRequestByChannel } from '../services/requests.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('ticketadd')
  .setDescription('Add a user to the current ticket channel')
  .setContexts(0)
  .addUserOption((o) =>
    o.setName('user').setDescription('User to add to this ticket').setRequired(true)
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const req = getRequestByChannel(interaction.channelId);
  if (!req) {
    return interaction.reply({ content: 'This command can only be used inside a ticket channel.', flags: MessageFlags.Ephemeral });
  }

  // Only the assigned activator (issuer), the requester (buyer), or whitelisted staff can add users
  const userId = interaction.user.id;
  if (userId !== req.issuer_id && userId !== req.buyer_id) {
    const { isWhitelisted } = await import('../utils/whitelist.js');
    if (!isWhitelisted(userId)) {
      return interaction.reply({ content: 'Only the assigned activator, the requester, or staff can add users to this ticket.', flags: MessageFlags.Ephemeral });
    }
  }

  const target = interaction.options.getUser('user');
  if (target.bot) {
    return interaction.reply({ content: 'Cannot add bots to tickets.', flags: MessageFlags.Ephemeral });
  }

  const channel = interaction.channel;
  try {
    await channel.permissionOverwrites.edit(target.id, {
      [PermissionFlagsBits.ViewChannel]: true,
      [PermissionFlagsBits.SendMessages]: true,
      [PermissionFlagsBits.ReadMessageHistory]: true,
    });

    await interaction.reply({
      content: `✅ <@${target.id}> has been added to this ticket.`,
    });
  } catch (err) {
    await interaction.reply({
      content: `❌ Failed to add user: ${err?.message || 'Unknown error'}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
