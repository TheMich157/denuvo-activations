import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getBalance } from '../services/points.js';
import { formatPointsAsMoney } from '../utils/pointsFormat.js';
import { isActivator } from '../utils/activator.js';

export const data = new SlashCommandBuilder()
  .setName('shop')
  .setDescription('View point packages and cashout info (1 point = 1¢)')
  .setContexts(0);

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
  const balance = getBalance(interaction.user.id);
  const activator = isActivator(interaction.member);

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
    .addFields(buyFields)
    .addFields({
      name: '\u200b',
      value: '**How to buy:** DM staff to purchase — PayPal, Patreon, etc. Staff will use `/addpoints` to credit your account.',
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
    .setFooter({ text: activator ? 'Earn points by completing activations • Cashout coming soon' : 'DM staff to purchase points' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
