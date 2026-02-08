import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { getRequestByChannel } from '../services/requests.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('ticketremove')
  .setDescription('Remove a user from the current ticket channel')
  .setContexts(0)
  .addUserOption((o) =>
    o.setName('user').setDescription('User to remove from this ticket').setRequired(true)
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const req = getRequestByChannel(interaction.channelId);
  if (!req) {
    return interaction.reply({ content: 'This command can only be used inside a ticket channel.', flags: MessageFlags.Ephemeral });
  }

  // Only the assigned activator (issuer) or whitelisted staff can remove users
  const userId = interaction.user.id;
  if (userId !== req.issuer_id) {
    const { isWhitelisted } = await import('../utils/whitelist.js');
    if (!isWhitelisted(userId)) {
      return interaction.reply({ content: 'Only the assigned activator or staff can remove users from this ticket.', flags: MessageFlags.Ephemeral });
    }
  }

  const target = interaction.options.getUser('user');

  // Prevent removing the buyer, issuer, or the bot itself
  if (target.id === req.buyer_id) {
    return interaction.reply({ content: 'Cannot remove the requester from their own ticket.', flags: MessageFlags.Ephemeral });
  }
  if (target.id === req.issuer_id) {
    return interaction.reply({ content: 'Cannot remove the assigned activator. Use `/transfer` to reassign the ticket instead.', flags: MessageFlags.Ephemeral });
  }
  if (target.id === interaction.client.user.id) {
    return interaction.reply({ content: 'Cannot remove the bot from the ticket.', flags: MessageFlags.Ephemeral });
  }

  const channel = interaction.channel;
  try {
    await channel.permissionOverwrites.edit(target.id, {
      [PermissionFlagsBits.ViewChannel]: false,
      [PermissionFlagsBits.SendMessages]: false,
    });

    await interaction.reply({
      content: `✅ <@${target.id}> has been removed from this ticket.`,
    });
  } catch (err) {
    await interaction.reply({
      content: `❌ Failed to remove user: ${err?.message || 'Unknown error'}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
