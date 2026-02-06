import { SlashCommandBuilder } from 'discord.js';
import { clearStrikes, getStrikes } from '../services/strikes.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('clearestrikes')
  .setDescription('Clear strikes for a user (Activator only)')
  .setDMPermission(false)
  .addUserOption((o) => o.setName('user').setDescription('User to clear strikes for').setRequired(true));

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, ephemeral: true });
  if (!isActivator(interaction.member)) {
    return interaction.reply({ content: 'Only activators can use this command.', ephemeral: true });
  }

  const user = interaction.options.getUser('user');
  const before = getStrikes(user.id);
  clearStrikes(user.id);
  await interaction.reply({
    content: `Cleared ${before} strike(s) for <@${user.id}>.`,
    ephemeral: true,
  });
}
