import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { claimDaily, getDailyInfo, BASE_REWARD, STREAK_BONUS, MAX_STREAK_BONUS } from '../services/daily.js';
import { getBalance } from '../services/points.js';

export const data = new SlashCommandBuilder()
  .setName('daily')
  .setDescription('Claim your daily point reward');

export async function execute(interaction) {
  const userId = interaction.user.id;
  const result = claimDaily(userId);

  if (!result.ok) {
    if (result.error === 'already_claimed') {
      const remaining = result.nextClaimAt - Date.now();
      const hours = Math.floor(remaining / 3600000);
      const minutes = Math.ceil((remaining % 3600000) / 60000);
      const timeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

      const info = getDailyInfo(userId);
      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle('⏰ Already Claimed')
        .setDescription(`You've already claimed your daily reward today!\n\nCome back in **${timeStr}**.`)
        .addFields(
          { name: '🔥 Current Streak', value: `**${info.streak}** day${info.streak !== 1 ? 's' : ''}`, inline: true },
          { name: '🎁 Next Reward', value: `**${info.nextReward}** points`, inline: true }
        )
        .setFooter({ text: 'Daily rewards reset every 24 hours' })
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    return interaction.reply({ content: result.error, ephemeral: true });
  }

  const balance = getBalance(userId);
  const streakEmoji = result.streak >= 7 ? '🔥' : result.streak >= 3 ? '✨' : '⭐';

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🎁 Daily Reward Claimed!')
    .setDescription(`You received **${result.reward}** points!`)
    .addFields(
      { name: `${streakEmoji} Streak`, value: `**${result.streak}** day${result.streak !== 1 ? 's' : ''}`, inline: true },
      { name: '💰 Balance', value: `**${balance}** points`, inline: true }
    );

  if (result.streak > 1) {
    const bonus = result.reward - BASE_REWARD;
    embed.addFields({ name: '🎯 Streak Bonus', value: `+**${bonus}** bonus points`, inline: true });
  }

  if (result.streak < MAX_STREAK_BONUS / STREAK_BONUS) {
    embed.setFooter({ text: `Keep your streak alive! Claim again within 48h. Max bonus: +${MAX_STREAK_BONUS} pts` });
  } else {
    embed.setFooter({ text: '🏆 Max streak bonus reached! Keep it going!' });
  }

  embed.setTimestamp();
  return interaction.reply({ embeds: [embed] });
}
