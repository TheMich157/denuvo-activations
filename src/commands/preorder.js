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
  getAllPreorders,
  deletePreorder,
  fulfillPreorder,
  refillPreorder,
  getClaimsForPreorder,
  getPreorderSpots,
  getClaim,
  submitClaim,
  verifyClaim,
  isPreorderFull,
  closePreorder,
  removeClaim,
  updatePreorder,
  formatSpotsText,
  buildPreorderEmbed,
} from '../services/preorder.js';
import { createTicketForGame } from '../services/ticket.js';
import { config } from '../config.js';
import {
  logPreorderCreated,
  logPreorderStatus,
  logPreorderVerify,
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
      .setDescription('List preorders')
      .addStringOption((o) => o.setName('status').setDescription('Filter by status').setRequired(false)
        .addChoices(
          { name: 'Open', value: 'open' },
          { name: 'Closed', value: 'closed' },
          { name: 'Fulfilled', value: 'fulfilled' },
          { name: 'All', value: 'all' },
        ))
  )
  .addSubcommand((sub) =>
    sub.setName('claims')
      .setDescription('View all claims for a preorder')
      .addIntegerOption((o) => o.setName('id').setDescription('Preorder ID').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('removeclaim')
      .setDescription('Remove a user\'s claim from a preorder')
      .addIntegerOption((o) => o.setName('id').setDescription('Preorder ID').setRequired(true))
      .addUserOption((o) => o.setName('user').setDescription('User to remove').setRequired(true))
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
    sub.setName('verify')
      .setDescription('Manually verify a user\'s claim (skip screenshot)')
      .addIntegerOption((o) => o.setName('id').setDescription('Preorder ID').setRequired(true))
      .addUserOption((o) => o.setName('user').setDescription('User to verify').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('edit')
      .setDescription('Edit an existing preorder')
      .addIntegerOption((o) => o.setName('id').setDescription('Preorder ID').setRequired(true))
      .addNumberOption((o) => o.setName('price').setDescription('New price ($)').setRequired(false))
      .addIntegerOption((o) => o.setName('spots').setDescription('New max spots').setRequired(false))
      .addIntegerOption((o) => o.setName('appid').setDescription('Steam App ID').setRequired(false))
      .addStringOption((o) => o.setName('description').setDescription('New description').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub.setName('guide')
      .setDescription('Post a locked guide in the preorder forum channel')
  );

/** Update the forum post embed for a preorder. */
async function updateForumPost(client, preorder, preorderId) {
  if (!preorder.thread_id) return;
  try {
    const thread = await client.channels.fetch(preorder.thread_id).catch(() => null);
    if (!thread) return;
    const starterMessage = await thread.fetchStarterMessage().catch(() => null);
    if (!starterMessage) return;
    const updatedEmbed = buildPreorderEmbed({
      preorder, preorderId,
      kofiUrl: config.kofiUrl,
      tipChannelId: config.tipVerifyChannelId,
    });
    await starterMessage.edit({ embeds: [updatedEmbed] }).catch(() => {});
  } catch {}
}

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
          const preorderObj = getPreorder(preorderId);
          const preorderEmbed = buildPreorderEmbed({
            preorder: preorderObj,
            preorderId,
            kofiUrl: config.kofiUrl,
            tipChannelId: config.tipVerifyChannelId,
          });

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
    const statusFilter = interaction.options.getString('status') || 'open';
    const preorders = statusFilter === 'all' ? getAllPreorders() : getAllPreorders(statusFilter);

    if (preorders.length === 0) {
      return interaction.reply({ content: `No ${statusFilter === 'all' ? '' : statusFilter + ' '}preorders found.`, flags: MessageFlags.Ephemeral });
    }

    const statusIcons = { open: '🟢', closed: '🔴', fulfilled: '✅' };
    const lines = preorders.slice(0, 20).map((p) => {
      const spots = getPreorderSpots(p.id);
      const spotsText = formatSpotsText(spots);
      const icon = statusIcons[p.status] || '⬜';
      return `${icon} **#${p.id}** — ${p.game_name} — $${p.price.toFixed(2)} — ${spotsText}`;
    });
    if (preorders.length > 20) lines.push(`... and ${preorders.length - 20} more`);

    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle(`📋 Preorders${statusFilter !== 'all' ? ` (${statusFilter})` : ''}`)
      .setDescription(lines.join('\n'))
      .setFooter({ text: `${preorders.length} total` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  /* ───────── CLAIMS ───────── */
  else if (sub === 'claims') {
    const id = interaction.options.getInteger('id');
    const preorder = getPreorder(id);
    if (!preorder) {
      return interaction.reply({ content: `Preorder **#${id}** not found.`, flags: MessageFlags.Ephemeral });
    }

    const claims = getClaimsForPreorder(id);
    if (claims.length === 0) {
      return interaction.reply({ content: `No claims for preorder **#${id}** (${preorder.game_name}).`, flags: MessageFlags.Ephemeral });
    }

    const lines = claims.map((c, i) => {
      const status = c.verified ? '✅ Verified' : '⏳ Pending';
      const timeAgo = c.created_at ? ` • <t:${Math.floor(new Date(c.created_at + 'Z').getTime() / 1000)}:R>` : '';
      return `${i + 1}. <@${c.user_id}> — ${status}${timeAgo}`;
    });

    const spots = getPreorderSpots(id);
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle(`🎟️ Claims for Preorder #${id}: ${preorder.game_name}`)
      .setDescription(lines.join('\n'))
      .addFields(
        { name: '📊 Summary', value: `${spots.verified} verified • ${spots.pending} pending • ${spots.claimed} total`, inline: true },
        { name: '🎟️ Spots', value: formatSpotsText(spots), inline: true },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  /* ───────── REMOVECLAIM ───────── */
  else if (sub === 'removeclaim') {
    const id = interaction.options.getInteger('id');
    const user = interaction.options.getUser('user');
    const preorder = getPreorder(id);
    if (!preorder) {
      return interaction.reply({ content: `Preorder **#${id}** not found.`, flags: MessageFlags.Ephemeral });
    }

    const removed = removeClaim(id, user.id);
    if (!removed) {
      return interaction.reply({ content: `<@${user.id}> has no claim on preorder **#${id}**.`, flags: MessageFlags.Ephemeral });
    }

    const spots = getPreorderSpots(id);
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('🗑️ Claim Removed')
      .setDescription(`Removed <@${user.id}>'s claim from preorder **#${id}** (${preorder.game_name}).`)
      .addFields({ name: '🎟️ Spots', value: formatSpotsText(spots), inline: true })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

    // Update forum post
    await updateForumPost(interaction.client, preorder, id);

    // DM the user
    try {
      await user.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0xed4245)
            .setDescription(`Your claim on preorder **#${id}** (${preorder.game_name}) has been removed by staff.`)
            .setTimestamp(),
        ],
      }).catch(() => {});
    } catch {}
  }

  /* ───────── CLOSE ───────── */
  else if (sub === 'close') {
    const id = interaction.options.getInteger('id');
    const preorder = getPreorder(id);
    if (!preorder) {
      return interaction.reply({ content: `Preorder **#${id}** not found.`, flags: MessageFlags.Ephemeral });
    }

    // Gather all claims before deletion so we can DM them
    const claims = getClaimsForPreorder(id);

    // Delete the forum post if it exists
    if (preorder.thread_id) {
      try {
        const thread = await interaction.client.channels.fetch(preorder.thread_id).catch(() => null);
        if (thread?.deletable) await thread.delete().catch(() => {});
      } catch {}
    }

    deletePreorder(id);

    // DM all claimants about the cancellation
    let dmsSent = 0;
    for (const claim of claims) {
      try {
        const user = await interaction.client.users.fetch(claim.user_id).catch(() => null);
        if (user) {
          const wasVerified = claim.verified === 1;
          await user.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0xed4245)
                .setTitle('🗑️ Preorder Cancelled')
                .setDescription(
                  [
                    `Preorder **#${id}** for **${preorder.game_name}** has been **cancelled** by staff.`,
                    wasVerified
                      ? '\nYour spot was **verified** — please contact a staff member about a refund or credit.'
                      : '\nYour reservation was **pending** and has been released.',
                    '',
                    'If you have questions, please reach out to a staff member.',
                  ].join('\n')
                )
                .setFooter({ text: `Preorder #${id} — Cancelled` })
                .setTimestamp(),
            ],
          }).catch(() => {});
          dmsSent++;
        }
      } catch {}
    }

    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('🗑️ Preorder Deleted')
      .setDescription(
        [
          `Preorder **#${id}** (${preorder.game_name}) and its forum post have been deleted.`,
          claims.length > 0 ? `📨 Notified **${dmsSent}/${claims.length}** claimant(s) about the cancellation.` : '',
        ].filter(Boolean).join('\n')
      )
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
    if (!preorder.game_app_id) {
      return interaction.reply({ content: `Preorder **#${id}** has no App ID set — cannot open tickets. Use \`/preorder edit ${id}\` to add one first, or recreate the preorder with an App ID.`, flags: MessageFlags.Ephemeral });
    }

    const claims = getClaimsForPreorder(id);
    const verified = claims.filter((c) => c.verified === 1);
    const unverified = claims.filter((c) => c.verified !== 1);

    if (verified.length === 0) {
      return interaction.reply({ content: `No verified users for preorder **#${id}**. Nothing to fulfill.`, flags: MessageFlags.Ephemeral });
    }

    fulfillPreorder(id);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Update forum post to show fulfilled status
    await updateForumPost(interaction.client, { ...preorder, status: 'fulfilled' }, id);

    // Open a ticket for every verified user — same as a normal activation
    let ticketsOpened = 0;
    let ticketsFailed = 0;

    for (const claim of verified) {
      try {
        const member = await interaction.guild.members.fetch(claim.user_id).catch(() => null);
        if (!member) { ticketsFailed++; continue; }

        const fakeInteraction = {
          user: member.user,
          member,
          guildId: interaction.guildId,
          guild: interaction.guild,
          client: interaction.client,
        };
        const result = await createTicketForGame(fakeInteraction, preorder.game_app_id, { requireTicketCategory: false, preorder: true });
        if (result.ok && result.channel) {
          ticketsOpened++;
          // Tag the ticket as a preorder fulfillment
          await result.channel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0xe91e63)
                .setTitle('🛒 Preorder Fulfillment')
                .setDescription(
                  [
                    `This ticket was created from **Preorder #${id}** — **${preorder.game_name}**.`,
                    `Ko-fi donation **verified** — proceed with activation as normal.`,
                    '',
                    `> Preorder created by <@${preorder.created_by}>`,
                  ].join('\n')
                )
                .setFooter({ text: `Preorder #${id}` })
                .setTimestamp(),
            ],
          }).catch(() => {});
        } else {
          ticketsFailed++;
        }
      } catch {
        ticketsFailed++;
      }
    }

    // DM unverified users that they missed out
    for (const claim of unverified) {
      try {
        const user = await interaction.client.users.fetch(claim.user_id).catch(() => null);
        if (user) {
          await user.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0xfee75c)
                .setTitle('⚠️ Preorder Fulfilled — You Were Not Verified')
                .setDescription(
                  `Preorder **#${id}** (${preorder.game_name}) has been fulfilled, but your spot was **never verified**.\n\n` +
                  'In the future, make sure to post your Ko-fi receipt in the tip verification channel after reserving a spot.'
                )
                .setFooter({ text: `Preorder #${id}` })
                .setTimestamp(),
            ],
          }).catch(() => {});
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
                .setDescription(
                  [
                    `This preorder has been fulfilled!`,
                    `🎫 **${ticketsOpened}** activation tickets opened for verified users.`,
                    ticketsFailed > 0 ? `⚠️ **${ticketsFailed}** ticket(s) could not be opened (user may have left).` : '',
                    unverified.length > 0 ? `⚠️ **${unverified.length}** user(s) had unverified spots and missed out.` : '',
                  ].filter(Boolean).join('\n')
                )
                .setTimestamp(),
            ],
          });
        }
      } catch {}
    }

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅ Preorder Fulfilled')
      .setDescription(
        [
          `Preorder **#${id}** (${preorder.game_name})`,
          `🎫 Opened **${ticketsOpened}/${verified.length}** activation tickets`,
          ticketsFailed > 0 ? `⚠️ **${ticketsFailed}** failed (user left server or error)` : '',
          unverified.length > 0 ? `⚠️ **${unverified.length}** unverified users notified they missed out` : '',
        ].filter(Boolean).join('\n')
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

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

    const spots = getPreorderSpots(id);
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('🔄 Preorder Refilled')
      .setDescription(
        [
          `Preorder **#${id}** (${preorder.game_name}) has been reopened.`,
          newSpots != null ? `New max spots: **${newSpots}**` : 'Max spots unchanged.',
          `🎟️ ${formatSpotsText(spots)}`,
        ].join('\n')
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

    // Update forum post to reflect reopened status
    await updateForumPost(interaction.client, getPreorder(id), id);

    logPreorderStatus({
      preorderId: id,
      gameName: preorder.game_name,
      action: 'refilled',
      actor: interaction.user.id,
      spotsInfo: spots,
    }).catch(() => {});
  }

  /* ───────── VERIFY (manual — skips screenshot) ───────── */
  else if (sub === 'verify') {
    const id = interaction.options.getInteger('id');
    const user = interaction.options.getUser('user');
    const preorder = getPreorder(id);
    if (!preorder) {
      return interaction.reply({ content: `Preorder **#${id}** not found.`, flags: MessageFlags.Ephemeral });
    }

    // Create claim if it doesn't exist, then verify
    const existing = getClaim(id, user.id);
    if (existing && existing.verified) {
      return interaction.reply({ content: `<@${user.id}> is already **verified** on preorder **#${id}**.`, flags: MessageFlags.Ephemeral });
    }

    if (!existing) {
      submitClaim(id, user.id, null);
    }
    verifyClaim(id, user.id);

    const spots = getPreorderSpots(id);
    const spotsText = formatSpotsText(spots);

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅ Manually Verified')
      .setDescription(
        [
          `<@${user.id}>'s spot on preorder **#${id}** (${preorder.game_name}) has been **manually verified** by <@${interaction.user.id}>.`,
          '',
          `🎟️ ${spotsText}`,
        ].join('\n')
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

    // DM the user
    try {
      await user.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle('✅ Spot Confirmed!')
            .setDescription(
              [
                `Your spot on preorder **#${id}** (${preorder.game_name}) has been **manually verified** by staff!`,
                '',
                'You\'ll receive a DM when the preorder is fulfilled and your activation is ready.',
                '',
                `🎟️ ${spotsText}`,
              ].join('\n')
            )
            .setFooter({ text: `Preorder #${id}` })
            .setTimestamp(),
        ],
      }).catch(() => {});
    } catch {}

    // Log
    logPreorderVerify({
      preorderId: id,
      gameName: preorder.game_name,
      userId: user.id,
      amount: null,
      method: 'manual_command',
      verifiedBy: interaction.user.id,
    }).catch(() => {});

    // Update forum post
    await updateForumPost(interaction.client, preorder, id);

    // Notify thread
    if (preorder.thread_id) {
      try {
        const thread = await interaction.client.channels.fetch(preorder.thread_id).catch(() => null);
        if (thread) {
          await thread.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x57f287)
                .setDescription(`✅ <@${user.id}>'s spot manually verified by <@${interaction.user.id}>\n🎟️ ${spotsText}`)
                .setTimestamp(),
            ],
          });
        }
      } catch {}
    }

    // Auto-close if full
    if (isPreorderFull(id)) {
      closePreorder(id);
      logPreorderStatus({ preorderId: id, gameName: preorder.game_name, action: 'closed', actor: interaction.client.user.id, spotsInfo: spots }).catch(() => {});
      await updateForumPost(interaction.client, { ...preorder, status: 'closed' }, id);
      if (preorder.thread_id) {
        try {
          const thread = await interaction.client.channels.fetch(preorder.thread_id).catch(() => null);
          if (thread) {
            await thread.send({
              embeds: [
                new EmbedBuilder()
                  .setColor(0xe67e22)
                  .setTitle('🔒 Preorder Full — Auto-Closed')
                  .setDescription(`All **${spots.total}** spots have been filled! This preorder is now closed.`)
                  .setTimestamp(),
              ],
            });
          }
        } catch {}
      }
    }
  }

  /* ───────── EDIT ───────── */
  else if (sub === 'edit') {
    const id = interaction.options.getInteger('id');
    const preorder = getPreorder(id);
    if (!preorder) {
      return interaction.reply({ content: `Preorder **#${id}** not found.`, flags: MessageFlags.Ephemeral });
    }

    const newPrice = interaction.options.getNumber('price');
    const newSpots = interaction.options.getInteger('spots');
    const newAppId = interaction.options.getInteger('appid');
    const newDesc = interaction.options.getString('description');

    if (newPrice === null && newSpots === null && newAppId === null && newDesc === null) {
      return interaction.reply({ content: 'Provide at least one field to edit (price, spots, appid, or description).', flags: MessageFlags.Ephemeral });
    }

    if (newPrice !== null && newPrice < 1) {
      return interaction.reply({ content: 'Price must be at least $1.', flags: MessageFlags.Ephemeral });
    }
    if (newSpots !== null && newSpots < 0) {
      return interaction.reply({ content: 'Spots must be 0 (unlimited) or a positive number.', flags: MessageFlags.Ephemeral });
    }

    updatePreorder(id, {
      price: newPrice ?? undefined,
      maxSpots: newSpots ?? undefined,
      appId: newAppId ?? undefined,
      description: newDesc ?? undefined,
    });

    // Refresh after update
    const updated = getPreorder(id);
    const spots = getPreorderSpots(id);

    const changes = [];
    if (newPrice !== null) changes.push(`💰 Price → **$${newPrice.toFixed(2)}**`);
    if (newSpots !== null) changes.push(`🎟️ Max spots → **${newSpots || 'Unlimited'}**`);
    if (newAppId !== null) changes.push(`🎮 App ID → **${newAppId}**`);
    if (newDesc !== null) changes.push(`📝 Description updated`);

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('✏️ Preorder Updated')
      .setDescription(
        [
          `Preorder **#${id}** (${updated.game_name}) has been edited:`,
          '',
          ...changes,
          '',
          `🎟️ ${formatSpotsText(spots)}`,
        ].join('\n')
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

    // Update forum post
    await updateForumPost(interaction.client, updated, id);

    // Notify thread
    if (updated.thread_id) {
      try {
        const thread = await interaction.client.channels.fetch(updated.thread_id).catch(() => null);
        if (thread) {
          await thread.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x5865f2)
                .setTitle('✏️ Preorder Edited')
                .setDescription(`<@${interaction.user.id}> updated this preorder:\n${changes.join('\n')}\n\n🎟️ ${formatSpotsText(spots)}`)
                .setTimestamp(),
            ],
          });
        }
      } catch {}
    }

    logPreorderStatus({
      preorderId: id,
      gameName: updated.game_name,
      action: 'edited',
      actor: interaction.user.id,
      spotsInfo: spots,
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
