import { SlashCommandBuilder } from 'discord.js';
import { getStrikes } from '../services/strikes.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('strikes')
  .setDescription('Check your strike count')
  .setDMPermission(false)
  .addUserOption((o) =>
    o.setName('user').setDescription('User to check (Activator only)').setRequired(false)
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, ephemeral: true });
  const target = interaction.options.getUser('user') ?? interaction.user;
  const selfCheck = target.id === interaction.user.id;

  if (!selfCheck) {
    const { isActivator } = await import('../utils/activator.js');
    if (!isActivator(interaction.member)) {
      return interaction.reply({ content: 'Only activators can check another user\'s strikes.', ephemeral: true });
    }
  }

  const strikes = getStrikes(target.id);
  const msg = selfCheck
    ? `You have **${strikes}** strike(s). Invalid tokens add strikes.`
    : `<@${target.id}> has **${strikes}** strike(s).`;
  await interaction.reply({ content: msg, ephemeral: true });
}
