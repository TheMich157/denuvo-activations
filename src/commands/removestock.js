import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getGameByAppId } from '../utils/games.js';
import { removeActivatorStock, getActivatorGames } from '../services/activators.js';
import { getStockCount } from '../services/stock.js';
import { logRestock } from '../services/activationLog.js';
import { syncPanelMessage } from '../services/panel.js';
import { buildPanelMessagePayload } from './ticketpanel.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';
import { checkRateLimit, getRemainingCooldown } from '../utils/rateLimit.js';

export const data = new SlashCommandBuilder()
  .setName('removestock')
  .setDescription('Remove stock from a game (Activator only)')
  .setContexts(0)
  .addStringOption((o) =>
    o
      .setName('game')
      .setDescription('Game to remove stock from')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addIntegerOption((o) =>
    o
      .setName('quantity')
      .setDescription('How many pieces to remove (1–9999)')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(9999)
  );

export async function autocomplete(interaction) {
  const games = getActivatorGames(interaction.user.id).filter((g) => (g.stock_quantity ?? 0) > 0);
  const focused = (interaction.options.getFocused() || '').toLowerCase();
  const filtered = focused
    ? games.filter((g) => g.game_name.toLowerCase().includes(focused))
    : games;
  await interaction.respond(
    filtered.slice(0, 25).map((g) => ({
      name: `${g.game_name} (${g.stock_quantity} in stock)`,
      value: String(g.game_app_id),
    }))
  );
}

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });
  if (!isActivator(interaction.member)) {
    return interaction.reply({ content: 'Only activators can remove stock.', flags: MessageFlags.Ephemeral });
  }
  if (!checkRateLimit(interaction.user.id, 'removestock', 20, 60000)) {
    const sec = getRemainingCooldown(interaction.user.id, 'removestock');
    return interaction.reply({ content: `Rate limited. Try again in ${sec}s.`, flags: MessageFlags.Ephemeral });
  }
  const appId = parseInt(interaction.options.getString('game'), 10);
  const quantity = interaction.options.getInteger('quantity');
  const game = getGameByAppId(appId);
  if (!game) {
    return interaction.reply({ content: 'Game not found.', flags: MessageFlags.Ephemeral });
  }

  const result = removeActivatorStock(interaction.user.id, appId, quantity);
  if (!result.ok) {
    return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
  }

  // Log the removal
  logRestock({
    activatorId: interaction.user.id,
    gameAppId: appId,
    gameName: game.name,
    quantity: -result.removed,
    method: 'manual',
  }).catch(() => {});

  const totalStock = getStockCount(appId);
  const msg =
    result.remaining === 0
      ? `Removed **${result.removed}** piece(s) of **${game.name}**. Game removed from your stock (was 0). **${totalStock}** total in stock for this game.`
      : `Removed **${result.removed}** piece(s) of **${game.name}**. **${result.remaining}** left in your stock. **${totalStock}** total in stock.`;

  await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });

  // Auto-refresh panel
  syncPanelMessage(interaction.client, buildPanelMessagePayload()).catch(() => {});
}
