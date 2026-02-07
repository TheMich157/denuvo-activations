import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} from 'discord.js';
import { requireGuild } from '../utils/guild.js';
import {
  createPreorder,
  setPreorderThread,
  getPreorder,
  getOpenPreorders,
  closePreorder,
  deletePreorder,
  fulfillPreorder,
  refillPreorder,
  getClaimsForPreorder,
  getPreorderSpots,
} from '../services/preorder.js';
import { config } from '../config.js';
import {
  logPreorderCreated,
  logPreorderStatus,
} from '../services/activationLog.js';

export const data = new SlashCommandBuilder()
  .setName('preorder')
  .setDescription('Manage game preorders')
  .setContexts(0)
  .addSubcommand((sub) =>
    sub.setName('create')
      .setDescription('Create a new preorder')
      .addStringOption((o) => o.setName('game').setDescription('Game name').setRequired(true))
      .addNumberOption((o) => o.setName('price').setDescription('Minimum donation price ($)').setRequired(true))
      .addIntegerOption((o) => o.setName('spots').setDescription('Max spots (0 = unlimited)').setRequired(false))
      .addIntegerOption((o) => o.setName('appid').setDescription('Steam App ID (optional)').setRequired(false))
      .addStringOption((o) => o.setName('description').setDescription('Description (optional)').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub.setName('list')
      .setDescription('List all open preorders')
  )
  .addSubcommand((sub) =>
    sub.setName('close')
      .setDescription('Close and delete a preorder')
      .addIntegerOption((o) => o.setName('id').setDescription('Preorder ID').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('fulfill')
      .setDescription('Fulfill a preorder — notify verified users')
      .addIntegerOption((o) => o.setName('id').setDescription('Preorder ID').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('refill')
      .setDescription('Reopen a closed preorder')
      .addIntegerOption((o) => o.setName('id').setDescription('Preorder ID').setRequired(true))
      .addIntegerOption((o) => o.setName('spots').setDescription('New max spots (optional)').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub.setName('guide')
      .setDescription('Post a locked guide in the preorder forum channel')
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const sub = interaction.options.getSubcommand();

  /* ───────── CREATE ───────── */
  if (sub === 'create') {
    const gameName = interaction.options.getString('game');
    const price = interaction.options.getNumber('price');
    const maxSpots = interaction.options.getInteger('spots') ?? 0;
    const appId = interaction.options.getInteger('appid');
    const description = interaction.options.getString('description');

    if (price < 1) {
      return interaction.reply({ content: 'Price must be at least $1.', flags: MessageFlags.Ephemeral });
    }
    if (maxSpots < 0) {
      return interaction.reply({ content: 'Spots must be 0 (unlimited) or a positive number.', flags: MessageFlags.Ephemeral });
    }

    const preorderId = createPreorder(gameName, appId, description, price, interaction.user.id, maxSpots);

    // Create a forum post in the preorder forum channel if configured
    let forumPost = null;
    if (config.preorderChannelId) {
      try {
        const channel = await interaction.client.channels.fetch(config.preorderChannelId);
        if (channel && channel.type === ChannelType.GuildForum) {
          const spotsText = maxSpots > 0 ? `0/${maxSpots} claimed • **${maxSpots}** remaining` : 'Unlimited spots';

          const preorderEmbed = new EmbedBuilder()
            .setColor(0xe91e63)
            .setTitle(`🛒 Preorder #${preorderId}: ${gameName}`)
            .setDescription(
              [
                description || `Preorder for **${gameName}** is now open!`,
                '',
                `**💰 Minimum donation:** $${price.toFixed(2)}`,
                `**🎟️ Spots:** ${spotsText}`,
                `**🔗 Donate:** [Ko-fi](${config.kofiUrl})`,
                '',
                '**How to claim your spot:**',
                `1. Click **"Reserve Spot"** below to hold your place`,
                `2. Donate at least **$${price.toFixed(2)}** on [Ko-fi](${config.kofiUrl})`,
                `3. Post your receipt screenshot in <#${config.tipVerifyChannelId || 'tip-verify'}> with **#${preorderId}**`,
                '4. Bot auto-verifies your payment and **confirms your spot**',
                '5. Once fulfilled, you\'ll receive your activation!',
                '',
                '> Reserved spots must be verified within 48 hours or they will be released.',
              ].join('\n')
            )
            .addFields(
              { name: '🎮 Game', value: gameName, inline: true },
              { name: '📋 Status', value: '🟢 Open', inline: true },
              { name: '🎟️ Spots', value: spotsText, inline: true },
              { name: '👤 Created by', value: `<@${interaction.user.id}>`, inline: true },
            )
            .setFooter({ text: `Preorder #${preorderId} • ${spotsText}` })
            .setTimestamp();

          const donateRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setLabel('Donate on Ko-fi')
              .setStyle(ButtonStyle.Link)
              .setURL(config.kofiUrl)
              .setEmoji('☕'),
            new ButtonBuilder()
              .setCustomId(`preorder_claim:${preorderId}`)
              .setLabel('Reserve Spot')
              .setStyle(ButtonStyle.Success)
              .setEmoji('🎟️'),
          );

          forumPost = await channel.threads.create({
            name: `Preorder #${preorderId}: ${gameName.slice(0, 90)}`,
            autoArchiveDuration: 10080,
            message: {
              embeds: [preorderEmbed],
              components: [donateRow],
            },
          });
          setPreorderThread(preorderId, forumPost.id);
        }
      } catch (err) {
        // Continue even if forum post creation fails
      }
    }

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅ Preorder Created')
      .setDescription(
        [
          `**#${preorderId}** — ${gameName}`,
          `💰 Price: $${price.toFixed(2)}`,
          `🎟️ Max spots: ${maxSpots || 'Unlimited'}`,
          forumPost ? `📌 Forum post: <#${forumPost.id}>` : '📌 No forum post (PREORDER_CHANNEL_ID not set)',
        ].join('\n')
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

    logPreorderCreated({
      preorderId,
      gameName,
      price,
      maxSpots,
      createdBy: interaction.user.id,
      threadId: forumPost?.id || null,
    }).catch(() => {});
  }

  /* ───────── LIST ───────── */
  else if (sub === 'list') {
    const open = getOpenPreorders();
    if (open.length === 0) {
      return interaction.reply({ content: 'No open preorders.', flags: MessageFlags.Ephemeral });
    }

    const lines = open.map((p) => {
      const spots = getPreorderSpots(p.id);
      const spotsText = spots?.unlimited
        ? `${spots.claimed} claimed / ${spots.verified} verified`
        : `${spots.claimed}/${spots.total} claimed • ${spots.verified} verified • ${spots.remaining} remaining`;
      return `**#${p.id}** — ${p.game_name} — $${p.price.toFixed(2)} — ${spotsText}`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('📋 Open Preorders')
      .setDescription(lines.join('\n'))
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  /* ───────── CLOSE ───────── */
  else if (sub === 'close') {
    const id = interaction.options.getInteger('id');
    const preorder = getPreorder(id);
    if (!preorder) {
      return interaction.reply({ content: `Preorder **#${id}** not found.`, flags: MessageFlags.Ephemeral });
    }

    // Delete the forum post if it exists
    if (preorder.thread_id) {
      try {
        const thread = await interaction.client.channels.fetch(preorder.thread_id).catch(() => null);
        if (thread?.deletable) await thread.delete().catch(() => {});
      } catch {}
    }

    deletePreorder(id);

    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('🗑️ Preorder Deleted')
      .setDescription(`Preorder **#${id}** (${preorder.game_name}) and its forum post have been deleted.`)
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

    logPreorderStatus({
      preorderId: id,
      gameName: preorder.game_name,
      action: 'deleted',
      actor: interaction.user.id,
      spotsInfo: null,
    }).catch(() => {});
  }

  /* ───────── FULFILL ───────── */
  else if (sub === 'fulfill') {
    const id = interaction.options.getInteger('id');
    const preorder = getPreorder(id);
    if (!preorder) {
      return interaction.reply({ content: `Preorder **#${id}** not found.`, flags: MessageFlags.Ephemeral });
    }

    const claims = getClaimsForPreorder(id);
    const verified = claims.filter((c) => c.verified === 1);

    if (verified.length === 0) {
      return interaction.reply({ content: `No verified users for preorder **#${id}**. Nothing to fulfill.`, flags: MessageFlags.Ephemeral });
    }

    fulfillPreorder(id);

    // DM all verified users
    let dmSuccess = 0;
    for (const claim of verified) {
      try {
        const user = await interaction.client.users.fetch(claim.user_id).catch(() => null);
        if (user) {
          await user.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x57f287)
                .setTitle('🎉 Preorder Fulfilled!')
                .setDescription(
                  [
                    `Your preorder **#${id}** for **${preorder.game_name}** has been fulfilled!`,
                    '',
                    'An activator will contact you shortly to complete your activation.',
                    'Please be ready to provide your Steam credentials when asked.',
                  ].join('\n')
                )
                .setFooter({ text: `Preorder #${id}` })
                .setTimestamp(),
            ],
          }).catch(() => {});
          dmSuccess++;
        }
      } catch {}
    }

    // Notify the forum thread
    if (preorder.thread_id) {
      try {
        const thread = await interaction.client.channels.fetch(preorder.thread_id).catch(() => null);
        if (thread) {
          await thread.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x57f287)
                .setTitle('✅ Preorder Fulfilled!')
                .setDescription(`This preorder has been fulfilled! All **${verified.length}** verified users have been notified.`)
                .setTimestamp(),
            ],
          });
        }
      } catch {}
    }

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅ Preorder Fulfilled')
      .setDescription(`Preorder **#${id}** (${preorder.game_name}) — DM'd **${dmSuccess}/${verified.length}** verified users.`)
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

    logPreorderStatus({
      preorderId: id,
      gameName: preorder.game_name,
      action: 'fulfilled',
      actor: interaction.user.id,
      spotsInfo: getPreorderSpots(id),
    }).catch(() => {});
  }

  /* ───────── REFILL ───────── */
  else if (sub === 'refill') {
    const id = interaction.options.getInteger('id');
    const newSpots = interaction.options.getInteger('spots');
    const preorder = getPreorder(id);
    if (!preorder) {
      return interaction.reply({ content: `Preorder **#${id}** not found.`, flags: MessageFlags.Ephemeral });
    }

    refillPreorder(id, newSpots);

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('🔄 Preorder Refilled')
      .setDescription(
        [
          `Preorder **#${id}** (${preorder.game_name}) has been reopened.`,
          newSpots != null ? `New max spots: **${newSpots}**` : 'Max spots unchanged.',
        ].join('\n')
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

    logPreorderStatus({
      preorderId: id,
      gameName: preorder.game_name,
      action: 'refilled',
      actor: interaction.user.id,
      spotsInfo: getPreorderSpots(id),
    }).catch(() => {});
  }

  /* ───────── GUIDE ───────── */
  else if (sub === 'guide') {
    if (!config.preorderChannelId) {
      return interaction.reply({ content: 'PREORDER_CHANNEL_ID is not set. Configure it in `.env`.', flags: MessageFlags.Ephemeral });
    }

    try {
      const channel = await interaction.client.channels.fetch(config.preorderChannelId);
      if (!channel || channel.type !== ChannelType.GuildForum) {
        return interaction.reply({ content: 'Preorder channel must be a Forum channel.', flags: MessageFlags.Ephemeral });
      }

      const guideEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('📖 Preorder Guide')
        .setDescription(
          [
            '**How the preorder system works:**',
            '',
            '1. **Reserve your spot** — Click the "Reserve Spot" button on any open preorder',
            '2. **Donate on Ko-fi** — Send the listed amount to our [Ko-fi page](' + config.kofiUrl + ')',
            '3. **Post proof** — Screenshot your Ko-fi receipt and post it in the tip verification channel',
            '4. **Include the preorder number** — Put `#ID` in your message (e.g. `#5`)',
            '5. **Auto-verification** — The bot reads your screenshot and confirms your spot',
            '6. **Fulfillment** — When the game is ready, all verified users get notified',
            '',
            '**Important notes:**',
            '• Your spot is reserved when you click the button, but **must be verified within 48 hours**',
            '• Unverified spots may be released to other users',
            '• Ko-fi tier members get price discounts (Mid: 10%, High: 20%)',
            '• If auto-verification fails, staff will manually review your proof',
          ].join('\n')
        )
        .setFooter({ text: 'DenuBrew Preorder System' })
        .setTimestamp();

      const guidePost = await channel.threads.create({
        name: '📖 Guide — How Preorders Work',
        autoArchiveDuration: 10080,
        message: { embeds: [guideEmbed] },
      });

      // Lock the thread so nobody can reply
      await guidePost.setLocked(true).catch(() => {});
      await guidePost.pin().catch(() => {});

      await interaction.reply({ content: `Guide posted and locked: <#${guidePost.id}>`, flags: MessageFlags.Ephemeral });
    } catch (err) {
      await interaction.reply({ content: `Failed to create guide: ${err.message}`, flags: MessageFlags.Ephemeral });
    }
  }
}
