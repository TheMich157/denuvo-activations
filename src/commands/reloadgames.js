import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { clearGamesCache, loadGames } from '../utils/games.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('reloadgames')
  .setDescription('Reload game list from list.json (Activator only)')
  .setContexts(0);

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });
  if (!isActivator(interaction.member)) {
    return interaction.reply({ content: 'Only activators can reload the game list.', flags: MessageFlags.Ephemeral });
  }
  clearGamesCache();
  const games = loadGames();
  await interaction.reply({
    content: `✅ Reloaded **${games.length}** games from list.json.`,
    flags: MessageFlags.Ephemeral,
  });
}
