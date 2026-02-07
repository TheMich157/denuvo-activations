import { getActiveGiveaways, pickWinners, endGiveaway, getEntryCount } from './giveaway.js';
import { EmbedBuilder } from 'discord.js';
import { db } from '../db/index.js';

const CHECK_INTERVAL = 60_000; // Check every minute

/**
 * Start the giveaway auto-end scheduler.
 */
export function startGiveawayScheduler(client) {
  setInterval(async () => {
    try {
      const active = getActiveGiveaways();
      const now = new Date();
      for (const g of active) {
        if (new Date(g.ends_at) <= now) {
          const winners = pickWinners(g.id, g.max_winners);
          endGiveaway(g.id, winners);

          const winnerMentions = winners.length > 0
            ? winners.map((w) => `<@${w}>`).join(', ')
            : 'No entries — no winners.';

          // Update original message
          if (g.channel_id && g.message_id) {
            try {
              const channel = await client.channels.fetch(g.channel_id).catch(() => null);
              if (channel) {
                const msg = await channel.messages.fetch(g.message_id).catch(() => null);
                if (msg) {
                  const embed = new EmbedBuilder()
                    .setColor(0x57f287)
                    .setTitle(`🎉 GIVEAWAY ENDED: ${g.game_name}`)
                    .setDescription(`**Winner${winners.length !== 1 ? 's' : ''}:** ${winnerMentions}`)
                    .setFooter({ text: `Giveaway #${g.id} • ${getEntryCount(g.id)} entries • Ended` })
                    .setTimestamp();
                  await msg.edit({ embeds: [embed], components: [] });
                }
              }
            } catch {}
          }

          // DM winners (respect notify_giveaway preference)
          for (const winnerId of winners) {
            try {
              const prefs = db.prepare('SELECT notify_giveaway FROM users WHERE id = ?').get(winnerId);
              if ((prefs?.notify_giveaway ?? 1) === 0) continue;
              const user = await client.users.fetch(winnerId).catch(() => null);
              if (user) {
                await user.send({
                  embeds: [
                    new EmbedBuilder()
                      .setColor(0x57f287)
                      .setTitle('🎉 You Won a Giveaway!')
                      .setDescription(`Congratulations! You won the giveaway for **${g.game_name}**! An activator will contact you soon.`)
                      .setTimestamp(),
                  ],
                }).catch(() => {});
              }
            } catch {}
          }
        }
      }
    } catch (err) {
      console.error('[GiveawayScheduler] Error:', err.message);
    }
  }, CHECK_INTERVAL);
}
