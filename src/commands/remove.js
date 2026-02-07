import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getActivatorGames, removeActivatorGame } from '../services/activators.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('remove')
  .setDescription('Remove a game from your activator list')
  .setContexts(0)
  .addStringOption((o) =>
    o
      .setName('game')
      .setDescription('Game to remove')
      .setRequired(true)
      .setAutocomplete(true)
  );

export async function autocomplete(interaction) {
  const games = getActivatorGames(interaction.user.id);
  const focused = (interaction.options.getFocused() || '').toLowerCase();
  const filtered = focused
    ? games.filter((g) => g.game_name.toLowerCase().includes(focused))
    : games;
  await interaction.respond(
    filtered.slice(0, 25).map((g) => ({ name: g.game_name, value: String(g.game_app_id) }))
  );
}

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });
  if (!isActivator(interaction.member)) {
    return interaction.reply({ content: 'Only activators can use this command.', flags: MessageFlags.Ephemeral });
  }

  const appId = parseInt(interaction.options.getString('game'), 10);
  const games = getActivatorGames(interaction.user.id);
  const game = games.find((g) => g.game_app_id === appId);
  if (!game) {
    return interaction.reply({ content: 'You do not have this game registered.', flags: MessageFlags.Ephemeral });
  }

  removeActivatorGame(interaction.user.id, appId);
  await interaction.reply({ content: `Removed **${game.game_name}** from your list.`, flags: MessageFlags.Ephemeral });
}
