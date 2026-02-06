import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getBalance } from '../services/points.js';
import { formatPointsAsMoney } from '../utils/pointsFormat.js';

export const data = new SlashCommandBuilder()
  .setName('balance')
  .setDescription('Check your points balance (1 point = 1¢)')
  .setDMPermission(false);

export async function execute(interaction) {
  const points = getBalance(interaction.user.id);
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('💰 Your Balance')
    .setDescription(`**${points}** points (1 point = 1¢)`)
    .addFields({
      name: 'Cash value',
      value: formatPointsAsMoney(points),
      inline: true,
    })
    .setFooter({ text: 'Use /shop to buy more points' })
    .setTimestamp();
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
