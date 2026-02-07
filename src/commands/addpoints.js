import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { addPoints } from '../services/points.js';
import { formatPointsAsMoney } from '../utils/pointsFormat.js';
import { isActivator } from '../utils/activator.js';
import { isValidReason, isValidPointsAmount, sanitizeError } from '../utils/validate.js';
import { checkRateLimit, getRemainingCooldown } from '../utils/rateLimit.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('addpoints')
  .setDescription('Add points to a user (Activator only)')
  .setContexts(0)
  .addUserOption((o) => o.setName('user').setDescription('User to add points to').setRequired(true))
  .addIntegerOption((o) => o.setName('amount').setDescription('Points to add (1–1,000,000)').setRequired(true).setMinValue(1).setMaxValue(1_000_000))
  .addStringOption((o) => o.setName('reason').setDescription('Reason (e.g. purchase, boost)').setRequired(true));

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });
  if (!isActivator(interaction.member)) {
    return interaction.reply({ content: 'Only activators can use this command.', flags: MessageFlags.Ephemeral });
  }
  if (!checkRateLimit(interaction.user.id, 'addpoints', 10, 60000)) {
    const sec = getRemainingCooldown(interaction.user.id, 'addpoints');
    return interaction.reply({ content: `Rate limited. Try again in ${sec}s.`, flags: MessageFlags.Ephemeral });
  }
  const user = interaction.options.getUser('user');
  const amount = interaction.options.getInteger('amount');
  const reason = interaction.options.getString('reason');
  if (!isValidPointsAmount(amount)) {
    return interaction.reply({ content: 'Invalid points amount.', flags: MessageFlags.Ephemeral });
  }
  if (!isValidReason(reason)) {
    return interaction.reply({ content: 'Reason must be 1–100 characters.', flags: MessageFlags.Ephemeral });
  }
  const type = reason.length > 50 ? reason.slice(0, 47) + '...' : reason;
  try {
    addPoints(user.id, amount, type);
    await interaction.reply({
      content: `Added **${amount}** points to <@${user.id}> (${formatPointsAsMoney(amount)}).`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    await interaction.reply({
      content: `Could not add points: ${sanitizeError(err)}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
