import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { pointsToDollars, formatPointsAsMoney } from '../utils/pointsFormat.js';

export const data = new SlashCommandBuilder()
  .setName('shop')
  .setDescription('View point packages (1 point = 1¢)')
  .setDMPermission(false);

const PACKAGES = [
  { payUsd: 5, points: 500 },
  { payUsd: 10, points: 1100 },
  { payUsd: 25, points: 2750 },
  { payUsd: 50, points: 5500 },
];

export async function execute(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Point Shop')
    .setDescription(
      '**1 point = 1¢** — Points can be used for activations and more.\n\n' +
      'Pay in USD to receive points. Larger purchases include bonus points.'
    )
    .addFields(
      PACKAGES.map((p) => {
        const valueUsd = pointsToDollars(p.points);
        const bonus = p.points > p.payUsd * 100 ? ` (+${Math.round(((valueUsd / p.payUsd) - 1) * 100)}% bonus)` : '';
        return {
          name: `Pay $${p.payUsd} → ${p.points} points`,
          value: `= ${formatPointsAsMoney(p.points)} value${bonus}`,
          inline: true,
        };
      })
    )
    .setFooter({ text: 'DM staff to purchase — Patreon, PayPal, etc.' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
