import { SlashCommandBuilder, EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createGiveaway, setGiveawayMessage, getGiveaway, getActiveGiveaways, getEntryCount, endGiveaway, pickWinners } from '../services/giveaway.js';
import { requireGuild } from '../utils/guild.js';
import { db } from '../db/index.js';

export const data = new SlashCommandBuilder()
  .setName('giveaway')
  .setDescription('Manage giveaways')
  .setContexts(0)
  .addSubcommand((sub) =>
    sub.setName('create')
      .setDescription('Create a new giveaway')
      .addStringOption((o) => o.setName('game').setDescription('Game name').setRequired(true))
      .addIntegerOption((o) => o.setName('duration').setDescription('Duration in hours').setRequired(true))
      .addIntegerOption((o) => o.setName('winners').setDescription('Number of winners (default: 1)').setRequired(false))
      .addIntegerOption((o) => o.setName('appid').setDescription('Steam App ID (optional)').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub.setName('list')
      .setDescription('View active giveaways')
  )
  .addSubcommand((sub) =>
    sub.setName('end')
      .setDescription('End a giveaway early and pick winners')
      .addIntegerOption((o) => o.setName('id').setDescription('Giveaway ID').setRequired(true))
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const sub = interaction.options.getSubcommand();

  if (sub === 'create') {
    const gameName = interaction.options.getString('game');
    const hours = interaction.options.getInteger('duration');
    const maxWinners = interaction.options.getInteger('winners') ?? 1;
    const appId = interaction.options.getInteger('appid');

    if (hours < 1 || hours > 720) return interaction.reply({ content: 'Duration must be 1–720 hours.', flags: MessageFlags.Ephemeral });
    if (maxWinners < 1 || maxWinners > 50) return interaction.reply({ content: 'Winners must be 1–50.', flags: MessageFlags.Ephemeral });

    const endsAt = new Date(Date.now() + hours * 3600000).toISOString();
    const giveawayId = createGiveaway(gameName, appId, interaction.user.id, endsAt, maxWinners);
    const endsTimestamp = Math.floor(new Date(endsAt).getTime() / 1000);

    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle(`🎉 GIVEAWAY: ${gameName}`)
      .setDescription(
        [
          `**Free activation** for **${gameName}**!`,
          '',
          `🏆 **Winners:** ${maxWinners}`,
          `⏰ **Ends:** <t:${endsTimestamp}:R> (<t:${endsTimestamp}:F>)`,
          `👤 **Hosted by:** <@${interaction.user.id}>`,
          '',
          'Click the button below to enter!',
        ].join('\n')
      )
      .setFooter({ text: `Giveaway #${giveawayId} • 0 entries` })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`giveaway_enter:${giveawayId}`)
        .setLabel('🎉 Enter Giveaway')
        .setStyle(ButtonStyle.Primary),
    );

    const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });
    setGiveawayMessage(giveawayId, msg.id, interaction.channelId);
    return;
  }

  if (sub === 'list') {
    const active = getActiveGiveaways();
    if (active.length === 0) return interaction.reply({ content: 'No active giveaways.', flags: MessageFlags.Ephemeral });
    const lines = active.map((g) => {
      const entries = getEntryCount(g.id);
      const endsTs = Math.floor(new Date(g.ends_at).getTime() / 1000);
      return `**#${g.id}** — **${g.game_name}** • ${entries} entries • Ends <t:${endsTs}:R>`;
    });
    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle('🎉 Active Giveaways')
      .setDescription(lines.join('\n'))
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'end') {
    const id = interaction.options.getInteger('id');
    const giveaway = getGiveaway(id);
    if (!giveaway) return interaction.reply({ content: `Giveaway #${id} not found.`, flags: MessageFlags.Ephemeral });
    if (giveaway.status === 'ended') return interaction.reply({ content: `Giveaway #${id} already ended.`, flags: MessageFlags.Ephemeral });

    const winners = pickWinners(id, giveaway.max_winners);
    endGiveaway(id, winners);

    const winnerMentions = winners.length > 0 ? winners.map((w) => `<@${w}>`).join(', ') : 'No entries — no winners.';
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle(`🎉 Giveaway Ended: ${giveaway.game_name}`)
      .setDescription(`**Winner${winners.length !== 1 ? 's' : ''}:** ${winnerMentions}`)
      .setFooter({ text: `Giveaway #${id} • ${getEntryCount(id)} total entries` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });

    // DM winners (respect notify_giveaway preference)
    for (const winnerId of winners) {
      try {
        const prefs = db.prepare('SELECT notify_giveaway FROM users WHERE id = ?').get(winnerId);
        if ((prefs?.notify_giveaway ?? 1) === 0) continue;
        const user = await interaction.client.users.fetch(winnerId).catch(() => null);
        if (user) {
          await user.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x57f287)
                .setTitle('🎉 You Won a Giveaway!')
                .setDescription(`Congratulations! You won the giveaway for **${giveaway.game_name}**! An activator will contact you soon.`)
                .setTimestamp(),
            ],
          }).catch(() => {});
        }
      } catch {}
    }

    // Update original message if possible
    if (giveaway.channel_id && giveaway.message_id) {
      try {
        const channel = await interaction.client.channels.fetch(giveaway.channel_id).catch(() => null);
        if (channel) {
          const msg = await channel.messages.fetch(giveaway.message_id).catch(() => null);
          if (msg) {
            const updatedEmbed = EmbedBuilder.from(msg.embeds[0])
              .setColor(0x57f287)
              .setTitle(`🎉 GIVEAWAY ENDED: ${giveaway.game_name}`)
              .setDescription(`**Winner${winners.length !== 1 ? 's' : ''}:** ${winnerMentions}`)
              .setFooter({ text: `Giveaway #${id} • ${getEntryCount(id)} entries • Ended` });
            await msg.edit({ embeds: [updatedEmbed], components: [] });
          }
        }
      } catch {}
    }
  }
}
