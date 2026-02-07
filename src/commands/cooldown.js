import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getCooldownsForUser } from '../services/requests.js';
import { getGameByAppId, getGameDisplayName } from '../utils/games.js';

export const data = new SlashCommandBuilder()
  .setName('cooldown')
  .setDescription('View your active game cooldowns');

export async function execute(interaction) {
  const userId = interaction.user.id;
  const cooldowns = getCooldownsForUser(userId);

  if (cooldowns.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('⏱️ Cooldowns')
      .setDescription('You have no active cooldowns! You can request any game.')
      .setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  const now = Date.now();
  const lines = cooldowns.map((cd) => {
    const game = getGameByAppId(cd.game_app_id);
    const name = game ? getGameDisplayName(game) : `App ${cd.game_app_id}`;
    const until = new Date(cd.cooldown_until).getTime();
    const remaining = until - now;
    const hours = Math.floor(remaining / 3600000);
    const minutes = Math.ceil((remaining % 3600000) / 60000);
    const timeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    return `**${name}** — ${timeStr} remaining`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('⏱️ Active Cooldowns')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${cooldowns.length} active cooldown${cooldowns.length !== 1 ? 's' : ''} • Use /skiptoken buy to bypass` })
    .setTimestamp();

  return interaction.reply({ embeds: [embed], ephemeral: true });
}
