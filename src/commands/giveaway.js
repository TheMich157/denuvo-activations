import { SlashCommandBuilder, EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createGiveaway, setGiveawayMessage, getGiveaway, getActiveGiveaways, getEntryCount, endGiveaway, pickWinners } from '../services/giveaway.js';
import { requireGuild } from '../utils/guild.js';
import { db } from '../db/index.js';

/** Build the Claim button row for a giveaway winner. */
export function buildClaimRow(giveawayId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway_claim:${giveawayId}`)
      .setLabel('🎁 Claim Prize')
      .setStyle(ButtonStyle.Success),
  );
}

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
          appId ? `🏷️ **App ID:** [\`${appId}\`](https://store.steampowered.com/app/${appId})` : '',
          '',
          'Click the button below to enter! Press again to leave.',
        ].filter(Boolean).join('\n')
      )
      .setFooter({ text: `Giveaway #${giveawayId} • 0 entries` })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`giveaway_enter:${giveawayId}`)
        .setLabel('🎉 Enter Giveaway')
        .setStyle(ButtonStyle.Primary),
    );

    // Post the giveaway with @everyone ping
    const msg = await interaction.reply({
      content: '@everyone',
      embeds: [embed],
      components: [row],
      allowedMentions: { parse: ['everyone'] },
      fetchReply: true,
    });
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

    const totalEntries = getEntryCount(id);
    const winners = pickWinners(id, giveaway.max_winners);
    endGiveaway(id, winners);

    if (winners.length === 0) {
      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle(`🎉 Giveaway Ended: ${giveaway.game_name}`)
        .setDescription('No entries — no winners.')
        .setFooter({ text: `Giveaway #${id} • 0 entries` })
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });

      // Update original message
      if (giveaway.channel_id && giveaway.message_id) {
        try {
          const channel = await interaction.client.channels.fetch(giveaway.channel_id).catch(() => null);
          if (channel) {
            const msg = await channel.messages.fetch(giveaway.message_id).catch(() => null);
            if (msg) {
              const updatedEmbed = EmbedBuilder.from(msg.embeds[0])
                .setColor(0xed4245)
                .setTitle(`🎉 GIVEAWAY ENDED: ${giveaway.game_name}`)
                .setDescription('No entries — no winners.')
                .setFooter({ text: `Giveaway #${id} • 0 entries • Ended` });
              await msg.edit({ embeds: [updatedEmbed], components: [] });
            }
          }
        } catch {}
      }
      return;
    }

    const winnerMentions = winners.map((w) => `<@${w}>`).join(', ');
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle(`🎉 Giveaway Ended: ${giveaway.game_name}`)
      .setDescription(
        [
          `**Winner${winners.length !== 1 ? 's' : ''}:** ${winnerMentions}`,
          '',
          '🎁 Click **Claim Prize** on the giveaway post to open your activation ticket!',
        ].join('\n')
      )
      .setFooter({ text: `Giveaway #${id} • ${totalEntries} total entries` })
      .setTimestamp();

    await interaction.reply({ content: winnerMentions, embeds: [embed], allowedMentions: { users: winners } });

    // DM winners
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
                .setDescription(
                  `Congratulations! You won the giveaway for **${giveaway.game_name}**!\n\n` +
                  '🎁 Go to the giveaway post and click **Claim Prize** to open your activation ticket.'
                )
                .setTimestamp(),
            ],
          }).catch(() => {});
        }
      } catch {}
    }

    // Update original message — replace Enter button with Claim button
    if (giveaway.channel_id && giveaway.message_id) {
      try {
        const channel = await interaction.client.channels.fetch(giveaway.channel_id).catch(() => null);
        if (channel) {
          const msg = await channel.messages.fetch(giveaway.message_id).catch(() => null);
          if (msg) {
            const updatedEmbed = EmbedBuilder.from(msg.embeds[0])
              .setColor(0x57f287)
              .setTitle(`🎉 GIVEAWAY ENDED: ${giveaway.game_name}`)
              .setDescription(
                [
                  `**Winner${winners.length !== 1 ? 's' : ''}:** ${winnerMentions}`,
                  '',
                  '🎁 Winners: click **Claim Prize** below to open your activation ticket!',
                ].join('\n')
              )
              .setFooter({ text: `Giveaway #${id} • ${totalEntries} entries • Ended` });
            await msg.edit({ content: winnerMentions, embeds: [updatedEmbed], components: [buildClaimRow(id)], allowedMentions: { users: winners } });
          }
        }
      } catch {}
    }
  }
}
