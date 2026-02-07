import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getBalance, deductPoints } from '../services/points.js';
import { formatPointsAsMoney } from '../utils/pointsFormat.js';
import { isActivator } from '../utils/activator.js';
import { addTokens, SKIP_TOKEN_COST } from '../services/skipTokens.js';
import { db, scheduleSave } from '../db/index.js';

const SHOP_ITEMS = [
  { id: 'skip_token', name: '⚡ Skip Token', description: 'Bypass one activation cooldown', cost: SKIP_TOKEN_COST, emoji: '⚡' },
  { id: 'skip_token_3', name: '⚡ Skip Token ×3', description: '3 skip tokens (10% off)', cost: Math.floor(SKIP_TOKEN_COST * 3 * 0.9), quantity: 3, emoji: '⚡' },
  { id: 'priority_boost', name: '🌟 Priority Boost', description: 'Your next request gets VIP priority', cost: 150, emoji: '🌟' },
  { id: 'xp_boost', name: '📈 XP Boost (2h)', description: 'Double XP for 2 hours', cost: 100, emoji: '📈' },
];

export const data = new SlashCommandBuilder()
  .setName('shop')
  .setDescription('View and buy items with your points')
  .setContexts(0)
  .addSubcommand((sub) =>
    sub.setName('view').setDescription('View point packages and available items')
  )
  .addSubcommand((sub) =>
    sub.setName('buy')
      .setDescription('Purchase an item from the shop')
      .addStringOption((o) =>
        o.setName('item')
          .setDescription('Item to buy')
          .setRequired(true)
          .addChoices(...SHOP_ITEMS.map((i) => ({ name: `${i.emoji} ${i.name} — ${i.cost} pts`, value: i.id })))
      )
  );

const PACKAGES = [
  { payUsd: 5, points: 500 },
  { payUsd: 10, points: 1100 },
  { payUsd: 25, points: 2750 },
  { payUsd: 50, points: 5500 },
];

const CASHOUT_TIERS = [
  { points: 500, payoutUsd: 5 },
  { points: 1000, payoutUsd: 10 },
  { points: 2500, payoutUsd: 25 },
  { points: 5000, payoutUsd: 50 },
];

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'buy') return handleBuy(interaction);
  return handleView(interaction);
}

async function handleBuy(interaction) {
  const userId = interaction.user.id;
  const itemId = interaction.options.getString('item');
  const item = SHOP_ITEMS.find((i) => i.id === itemId);
  if (!item) return interaction.reply({ content: 'Item not found.', flags: MessageFlags.Ephemeral });

  const balance = getBalance(userId);
  if (balance < item.cost) {
    return interaction.reply({
      content: `Not enough points. **${item.name}** costs **${item.cost}** pts (you have **${balance}**).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // Process purchase based on item type
  if (itemId === 'skip_token') {
    deductPoints(userId, item.cost, 'shop_purchase', 'skip_token');
    addTokens(userId, 1);
  } else if (itemId === 'skip_token_3') {
    deductPoints(userId, item.cost, 'shop_purchase', 'skip_token_3');
    addTokens(userId, 3);
  } else if (itemId === 'priority_boost') {
    deductPoints(userId, item.cost, 'shop_purchase', 'priority_boost');
    db.prepare(`
      INSERT INTO users (id) VALUES (?) ON CONFLICT(id) DO NOTHING
    `).run(userId);
    db.prepare(`
      UPDATE users SET priority_boost = 1, updated_at = datetime('now') WHERE id = ?
    `).run(userId);
    scheduleSave();
  } else if (itemId === 'xp_boost') {
    deductPoints(userId, item.cost, 'shop_purchase', 'xp_boost');
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO users (id) VALUES (?) ON CONFLICT(id) DO NOTHING
    `).run(userId);
    db.prepare(`
      UPDATE users SET xp_boost_until = ?, updated_at = datetime('now') WHERE id = ?
    `).run(expiresAt, userId);
    scheduleSave();
  }

  const newBalance = getBalance(userId);
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('✅ Purchase Successful!')
    .setDescription(`You bought **${item.name}** for **${item.cost}** points.`)
    .addFields(
      { name: '💰 Remaining Balance', value: `**${newBalance}** pts`, inline: true }
    )
    .setTimestamp();

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleView(interaction) {
  const balance = getBalance(interaction.user.id);
  const activator = isActivator(interaction.member);

  // Shop items section
  const itemLines = SHOP_ITEMS.map((i) => {
    const canAfford = balance >= i.cost;
    const indicator = canAfford ? '✅' : '🔒';
    return `${indicator} **${i.name}** — **${i.cost}** pts\n\u2003${i.description}`;
  });

  const buyFields = PACKAGES.map((p) => {
    const bonus = p.points > p.payUsd * 100 ? ` (+${Math.round(((p.points / (p.payUsd * 100)) - 1) * 100)}% bonus)` : '';
    return {
      name: `💵 $${p.payUsd} → ${p.points} pts`,
      value: `= ${formatPointsAsMoney(p.points)}${bonus}`,
      inline: true,
    };
  });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🛒 Point Shop')
    .setDescription(
      `**1 point = 1¢** — Points can be used for activations and more.\nYour balance: **${balance}** pts (${formatPointsAsMoney(balance)})`
    )
    .addFields({ name: '🛍️ Items for Sale', value: itemLines.join('\n\n'), inline: false })
    .addFields(buyFields)
    .addFields({
      name: '\u200b',
      value: '**Buy items:** `/shop buy item:<item>`\n**Buy points:** DM staff — PayPal, Patreon, etc.',
      inline: false,
    });

  // Cashout section for activators
  if (activator) {
    const cashoutLines = CASHOUT_TIERS.map((t) => {
      const canAfford = balance >= t.points;
      const indicator = canAfford ? '✅' : '❌';
      return `${indicator} **${t.points} pts** → $${t.payoutUsd}`;
    });

    embed.addFields({
      name: '💸 Cashout (Activators)',
      value: cashoutLines.join('\n') + '\n\n⚠️ *Cashout is not yet available. This feature is coming soon — you\'ll be able to convert your earned points to real money. Keep earning!*',
      inline: false,
    });
  }

  embed
    .setFooter({ text: activator ? 'Earn points by completing activations • Cashout coming soon' : '/shop buy to purchase items' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
