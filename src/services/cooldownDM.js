import { EmbedBuilder } from 'discord.js';

/**
 * Send a DM to the user about their cooldown (e.g. after a request is completed or when blocked).
 * @param {import('discord.js').Client} client
 * @param {string} userId - Discord user ID
 * @param {{ gameName: string; cooldownUntil: number; hours: number }} options
 * @returns {Promise<boolean>} - true if DM was sent, false if failed (e.g. DMs closed)
 */
export async function sendCooldownDM(client, userId, { gameName, cooldownUntil, hours }) {
  try {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return false;
    const untilSec = Math.floor(cooldownUntil / 1000);
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('⏱️ Activation cooldown')
      .setDescription(
        `You can request **${gameName}** again **<t:${untilSec}:R>** (<t:${untilSec}:f>).`
      )
      .addFields({
        name: 'Cooldown',
        value: `**${hours} hour${hours !== 1 ? 's' : ''}** per request for this game. Use \`/profile\` to see all your cooldowns.`,
        inline: false,
      })
      .setFooter({ text: 'Game Activation' })
      .setTimestamp();
    await user.send({ embeds: [embed] });
    return true;
  } catch {
    return false;
  }
}
