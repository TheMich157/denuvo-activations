import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getBalance } from '../services/points.js';
import { getActivatorGames, getDailyCount, getPendingRestockCount, getNextRestockAt } from '../services/activators.js';
import { getCooldownsForUser } from '../services/requests.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';
import { formatPointsAsMoney } from '../utils/pointsFormat.js';
import { getGameDisplayName, getGameByAppId, getCooldownHours } from '../utils/games.js';
import { config } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('profile')
  .setDescription('View a profile: credits, cooldowns, and (for activators) games list')
  .setDMPermission(false)
  .addUserOption((o) =>
    o
      .setName('user')
      .setDescription('View this user\'s profile (leave empty for your own)')
      .setRequired(false)
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const targetUser = interaction.options.getUser('user') ?? interaction.user;
  const targetMember = targetUser.id === interaction.user.id
    ? interaction.member
    : await interaction.guild.members.fetch(targetUser.id).catch(() => null);
  const userId = targetUser.id;
  const points = getBalance(userId);
  const activator = targetMember ? isActivator(targetMember) : false;
  const games = activator ? getActivatorGames(userId) : [];
  const restockHours = config.restockHours || 24;
  const cooldowns = getCooldownsForUser(userId);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({
      name: targetUser.displayName || targetUser.username,
      iconURL: targetUser.displayAvatarURL({ size: 64 }),
    })
    .setTitle('Profile')
    .setTimestamp();
  const viewedBySuffix = targetUser.id !== interaction.user.id
    ? ` • Viewed by ${interaction.user.displayName || interaction.user.username}`
    : '';

  // —— Credits ——
  embed.addFields({
    name: '💰 Credits',
    value: `**${points}** points (${formatPointsAsMoney(points)})\n*1 point = 1¢ • Use /shop to buy*`,
    inline: true,
  });

  // —— Account type ——
  embed.addFields({
    name: '👤 Account',
    value: activator ? '**Activator** — You can add games and earn points' : '**Member** — Request games via panel or /request',
    inline: true,
  });

  // —— Cooldowns (for non-activators or anyone with cooldowns) ——
  if (cooldowns.length > 0) {
    const lines = cooldowns.map((c) => {
      const game = getGameByAppId(c.game_app_id);
      const displayName = game ? getGameDisplayName(game) : `App ${c.game_app_id}`;
      const until = new Date(c.cooldown_until).getTime();
      const hrs = getCooldownHours(c.game_app_id);
      return `• **${displayName}** — <t:${Math.floor(until / 1000)}:R> (${hrs}h cooldown)`;
    });
    embed.addFields({
      name: '⏱️ Your cooldowns',
      value: lines.join('\n') + '\n*You’ll get a DM when a cooldown applies. Request again after it expires.*',
      inline: false,
    });
  }

  // —— Activator games ——
  if (activator && games.length > 0) {
    const limit = config.dailyActivationLimit;
    const lines = games.map((g) => {
      const game = getGameByAppId(g.game_app_id);
      const displayName = game ? getGameDisplayName(game) : g.game_name;
      const steamId = g.steam_username || `manual_${userId}_${g.game_app_id}`;
      const today = getDailyCount(steamId);
      const remaining = Math.max(0, limit - today);
      const methodLabel = g.method === 'automated' ? '🤖' : '👤';
      const stock = g.stock_quantity ?? 5;
      const pending = getPendingRestockCount(userId, g.game_app_id);
      const nextAt = getNextRestockAt(userId, g.game_app_id);
      let restockText = '';
      if (pending > 0 && nextAt) {
        const ms = new Date(nextAt).getTime() - Date.now();
        const hrs = Math.max(0, Math.ceil(ms / (60 * 60 * 1000)));
        restockText = ` • +${pending} in ~${hrs}h`;
      } else if (pending > 0) restockText = ` • +${pending} restocking`;
      return `• **${displayName}** ${methodLabel} — stock: **${stock}**${restockText} • **${remaining}/${limit}** today`;
    });
    embed.addFields({
      name: '🎮 Your games (Activator)',
      value: lines.join('\n'),
      inline: false,
    });
    embed.setFooter({
      text: `Stock restocks after ${restockHours}h • ${limit} activations/day • /add or /stock${viewedBySuffix}`,
    });
  } else if (activator) {
    embed.addFields({
      name: '🎮 Your games',
      value: 'No games registered. Use `/add` or `/stock` to add games.',
      inline: false,
    });
    embed.setFooter({ text: `Activator • Use /add or /stock to add games${viewedBySuffix}` });
  } else if (cooldowns.length === 0) {
    embed.setFooter({ text: `Use /shop to buy points • Request games from the panel or /request${viewedBySuffix}` });
  } else if (viewedBySuffix) {
    embed.setFooter({ text: viewedBySuffix.slice(3) });
  }

  await interaction.reply({ embeds: [embed] });
}
