import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import { config } from '../config.js';
import { requireGuild } from '../utils/guild.js';
import {
  createPreorder,
  setPreorderThread,
  getPreorder,
  getOpenPreorders,
  deletePreorder,
  fulfillPreorder,
  refillPreorder,
  getClaimsForPreorder,
  getPreorderSpots,
} from '../services/preorder.js';
import {
  logPreorderCreated,
  logPreorderStatus,
} from '../services/activationLog.js';
import { createRequest, setTicketChannel, assignIssuer } from '../services/requests.js';
import { getActivatorsForGame, getBestActivator, getCredentials } from '../services/activators.js';
import { isAway } from '../services/activatorStatus.js';
import { notifyActivators } from '../services/statusNotify.js';

function spotsLabel(spots) {
  if (!spots) return '—';
  if (spots.unlimited) return `${spots.verified} verified (unlimited)`;
  return `${spots.verified}/${spots.total} verified • **${spots.remaining}** remaining`;
}

export const data = new SlashCommandBuilder()
  .setName('preorder')
  .setDescription('Manage game preorders (Activator only)')
  .setContexts(0)
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Create a new game preorder')
      .addStringOption((o) => o.setName('game').setDescription('Game name').setRequired(true))
      .addIntegerOption((o) => o.setName('spots').setDescription('Max spots (0 = unlimited)').setRequired(false))
      .addNumberOption((o) => o.setName('price').setDescription('Minimum donation in $ (default: 5)').setRequired(false))
      .addIntegerOption((o) => o.setName('appid').setDescription('Steam App ID (optional)').setRequired(false))
      .addStringOption((o) => o.setName('description').setDescription('Extra details about the preorder').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('View all open preorders')
  )
  .addSubcommand((sub) =>
    sub
      .setName('guide')
      .setDescription('Post a public guide explaining preorders and payment verification')
  )
  .addSubcommand((sub) =>
    sub
      .setName('close')
      .setDescription('Close a preorder')
      .addIntegerOption((o) => o.setName('id').setDescription('Preorder ID').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('fulfill')
      .setDescription('Mark a preorder as fulfilled (game activated for all verified users)')
      .addIntegerOption((o) => o.setName('id').setDescription('Preorder ID').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('refill')
      .setDescription('Reopen a closed/fulfilled preorder with optional new spot count')
      .addIntegerOption((o) => o.setName('id').setDescription('Preorder ID').setRequired(true))
      .addIntegerOption((o) => o.setName('spots').setDescription('New max spots (0 = unlimited, leave empty to keep current)').setRequired(false))
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const sub = interaction.options.getSubcommand();

  if (sub === 'create') {
    const gameName = interaction.options.getString('game');
    const price = interaction.options.getNumber('price') ?? config.minDonation;
    const appId = interaction.options.getInteger('appid');
    const description = interaction.options.getString('description');
    const maxSpots = interaction.options.getInteger('spots') ?? 0;

    if (price < 1) {
      return interaction.reply({ content: 'Minimum price is $1.', flags: MessageFlags.Ephemeral });
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
          const spotsText = maxSpots > 0 ? `**${maxSpots}** spots available` : 'Unlimited spots';

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
                '**How to claim:**',
                `1. Donate at least **$${price.toFixed(2)}** on [Ko-fi](${config.kofiUrl})`,
                `2. Click the **"I\'ve donated"** button below to claim your spot`,
                `3. Post your tip proof screenshot in <#${config.tipVerifyChannelId || 'tip-verify'}>`,
                `4. Mention preorder **#${preorderId}** in your proof`,
                '5. Bot will auto-verify your payment',
                '6. Once fulfilled, you\'ll receive your activation!',
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
              .setLabel('I\'ve donated — claim spot')
              .setStyle(ButtonStyle.Success)
              .setEmoji('✅'),
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

    // Log
    logPreorderCreated({
      preorderId,
      gameName,
      price,
      maxSpots,
      createdBy: interaction.user.id,
      threadId: forumPost?.id || null,
    }).catch(() => {});

    const spotsNote = maxSpots > 0 ? ` (${maxSpots} spots)` : ' (unlimited spots)';
    const replyText = forumPost
      ? `✅ Preorder **#${preorderId}** created for **${gameName}** ($${price.toFixed(2)})${spotsNote}. Post: <#${forumPost.id}>`
      : `✅ Preorder **#${preorderId}** created for **${gameName}** ($${price.toFixed(2)})${spotsNote}.`;

    return interaction.reply({ content: replyText, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'guide') {
    if (!config.preorderChannelId) {
      return interaction.reply({ content: 'PREORDER_CHANNEL_ID is not configured. Set it in `.env` first.', flags: MessageFlags.Ephemeral });
    }

    const channel = await interaction.client.channels.fetch(config.preorderChannelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildForum) {
      return interaction.reply({ content: 'The preorder channel must be a **Forum** channel.', flags: MessageFlags.Ephemeral });
    }

    const guideEmbed = new EmbedBuilder()
      .setColor(0xe91e63)
      .setTitle('🛒 How Preorders Work')
      .setDescription(
        [
          'Preorders let you request **upcoming or high-demand games** before they\'re available in the regular panel. Here\'s how it works:',
          '',
          '**━━━━━━━━━━━━━━━━━━━━━━**',
          '',
          '**Step 1 — Find a Preorder**',
          'Browse this forum for open preorder posts. Each post is a game you can preorder.',
          '',
          '**Step 2 — Donate on Ko-fi**',
          `Go to **[Ko-fi](${config.kofiUrl})** and donate the required minimum amount (usually **$${config.minDonation}+**).`,
          'Include your **Discord username** or the **preorder number** in the Ko-fi message so we can match it to you.',
          '',
          '**Step 3 — Claim Your Spot**',
          'Click the **"I\'ve donated — claim spot"** button on the preorder post you donated for.',
          '',
          '**Step 4 — Post Your Proof**',
          config.tipVerifyChannelId
            ? `Head to <#${config.tipVerifyChannelId}> and post a **screenshot** of your Ko-fi receipt.`
            : 'Post a **screenshot** of your Ko-fi receipt in the tip verification channel.',
          'Include the preorder number in your message, e.g.:',
          '```',
          '#5  or  preorder 5',
          '```',
          '',
          '**Step 5 — Automatic Verification**',
          'The bot will scan your screenshot and **auto-verify** your payment if it detects:',
          '• A Ko-fi / tip / donation receipt',
          `• The correct dollar amount (**$${config.minDonation}+** or whatever the preorder requires)`,
          '',
          'If auto-verification fails, an activator will **manually review** your proof.',
          '',
          '**Step 6 — Get Your Game**',
          'Once the preorder is **fulfilled**, you\'ll receive a DM and your activation will be handled!',
          '',
          '**━━━━━━━━━━━━━━━━━━━━━━**',
        ].join('\n')
      )
      .setTimestamp();

    const donateRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Donate on Ko-fi')
        .setStyle(ButtonStyle.Link)
        .setURL(config.kofiUrl)
        .setEmoji('☕'),
    );

    try {
      const guidePost = await channel.threads.create({
        name: '📌 Guide — How to Preorder',
        autoArchiveDuration: 10080,
        message: {
          embeds: [guideEmbed],
          components: [donateRow],
        },
      });
      await guidePost.setLocked(true);
      await guidePost.pin().catch(() => {});
      return interaction.reply({
        content: `✅ Guide posted and locked in the forum: <#${guidePost.id}>`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      return interaction.reply({
        content: `Failed to create guide post: ${err.message || 'Unknown error'}. Make sure the bot has permissions to create and manage threads in the forum channel.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  if (sub === 'list') {
    const preorders = getOpenPreorders();
    if (preorders.length === 0) {
      return interaction.reply({ content: 'No open preorders.', flags: MessageFlags.Ephemeral });
    }

    const lines = preorders.map((p) => {
      const spots = getPreorderSpots(p.id);
      const threadLink = p.thread_id ? ` • <#${p.thread_id}>` : '';
      return `**#${p.id}** — **${p.game_name}** • $${p.price.toFixed(2)} • ${spotsLabel(spots)}${threadLink}`;
    });

    const embed = new EmbedBuilder()
      .setColor(0xe91e63)
      .setTitle('🛒 Open Preorders')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `${preorders.length} open preorder${preorders.length !== 1 ? 's' : ''}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'close') {
    const id = interaction.options.getInteger('id');
    const preorder = getPreorder(id);
    if (!preorder) return interaction.reply({ content: `Preorder #${id} not found.`, flags: MessageFlags.Ephemeral });

    const spots = getPreorderSpots(id);
    const claims = getClaimsForPreorder(id);

    // Delete the forum thread if it exists
    if (preorder.thread_id) {
      try {
        const thread = await interaction.client.channels.fetch(preorder.thread_id).catch(() => null);
        if (thread?.deletable) await thread.delete().catch(() => {});
      } catch {}
    }

    // Log before deleting
    logPreorderStatus({ preorderId: id, gameName: preorder.game_name, action: 'closed', actor: interaction.user.id, spotsInfo: spots }).catch(() => {});

    // Delete the preorder and all claims from DB
    deletePreorder(id);

    // DM users that the preorder was cancelled
    for (const claim of claims) {
      try {
        const user = await interaction.client.users.fetch(claim.user_id).catch(() => null);
        if (user) {
          await user.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0xed4245)
                .setTitle('🗑️ Preorder Cancelled')
                .setDescription(`Preorder **#${id}** for **${preorder.game_name}** has been cancelled and removed by staff.`)
                .setTimestamp(),
            ],
          }).catch(() => {});
        }
      } catch {}
    }

    return interaction.reply({
      content: `🗑️ Preorder **#${id}** (${preorder.game_name}) has been **deleted**. Forum post removed, ${claims.length} claim${claims.length !== 1 ? 's' : ''} cleared.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'fulfill') {
    const id = interaction.options.getInteger('id');
    const preorder = getPreorder(id);
    if (!preorder) return interaction.reply({ content: `Preorder #${id} not found.`, flags: MessageFlags.Ephemeral });

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    fulfillPreorder(id);
    const claims = getClaimsForPreorder(id);
    const verifiedClaims = claims.filter((c) => c.verified === 1);

    if (verifiedClaims.length === 0) {
      const spots = getPreorderSpots(id);
      logPreorderStatus({ preorderId: id, gameName: preorder.game_name, action: 'fulfilled', actor: interaction.user.id, spotsInfo: spots }).catch(() => {});
      return interaction.editReply({ content: `✅ Preorder **#${id}** (${preorder.game_name}) marked as **fulfilled**, but no verified users — no tickets created.` });
    }

    // Get activators for this game (if appId is set)
    const gameAppId = preorder.game_app_id;
    const activators = gameAppId ? getActivatorsForGame(gameAppId) : [];
    const availableActivators = activators.filter((a) => !isAway(a.activator_id));
    const best = gameAppId ? getBestActivator(gameAppId) : null;

    let ticketsCreated = 0;
    let dmCount = 0;

    for (const claim of verifiedClaims) {
      try {
        // Create a request in the DB (like normal activation)
        const gameName = preorder.game_name;
        const requestId = createRequest(claim.user_id, gameAppId || 0, gameName);

        // Create a ticket channel
        if (config.ticketCategoryId && interaction.guild) {
          const overwrites = [
            { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: claim.user_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          ];
          if (config.activatorRoleId) {
            overwrites.push({
              id: config.activatorRoleId,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
            });
          }

          const ticketRef = `#${requestId.slice(0, 8).toUpperCase()}`;
          const channelName = `preorder-${gameName.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 25)}-${requestId.slice(0, 8)}`;

          const ticketChannel = await interaction.guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: config.ticketCategoryId,
            permissionOverwrites: overwrites,
          });

          setTicketChannel(requestId, ticketChannel.id);

          // Try auto-assign
          let autoAssigned = false;
          if (best) {
            const result = assignIssuer(requestId, best.activator_id);
            if (result.ok) autoAssigned = true;
          }

          const hasAutomated = autoAssigned ? !!getCredentials(best.activator_id, gameAppId) : false;

          const ticketEmbed = new EmbedBuilder()
            .setColor(0xe91e63)
            .setTitle(`🛒 Preorder Activation: ${gameName}`)
            .setDescription(
              [
                `**Requester:** <@${claim.user_id}>`,
                autoAssigned ? `**Auto-assigned to:** <@${best.activator_id}>` : '',
                '',
                `This ticket was created from **Preorder #${id}** — the user has a **verified donation**.`,
                '',
                autoAssigned
                  ? (hasAutomated
                    ? '**Automatic:** Use **Get code automatically** (enter 2FA). **Manual:** Use **Done** to paste the code.'
                    : 'Use **Done** to enter the auth code from drm.steam.run.')
                  : 'First activator to press the button claims this request.',
              ].filter(Boolean).join('\n')
            )
            .addFields(
              { name: '📋 Status', value: autoAssigned ? 'Auto-assigned — awaiting screenshot' : 'Waiting for activator', inline: true },
              { name: '🛒 Preorder', value: `#${id}`, inline: true },
            )
            .setFooter({ text: `Ticket ${ticketRef} • Preorder fulfillment` })
            .setTimestamp();

          const actionComponents = [];
          if (autoAssigned) {
            if (hasAutomated) {
              actionComponents.push(
                new ButtonBuilder().setCustomId(`auto_code:${requestId}`).setLabel('Get code automatically').setStyle(ButtonStyle.Primary).setEmoji('⚡')
              );
            }
            actionComponents.push(
              new ButtonBuilder().setCustomId('done_request').setLabel('Done – enter auth code').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId('call_activator').setLabel('Help').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId('close_ticket').setLabel('Close ticket').setStyle(ButtonStyle.Secondary),
            );
          } else {
            const activatorMentions = (availableActivators.length > 0 ? availableActivators : activators)
              .map((a) => `<@${a.activator_id}>`).join(' ');
            if (activatorMentions) ticketEmbed.setDescription(ticketEmbed.data.description + `\n\n${activatorMentions}`);
            actionComponents.push(
              new ButtonBuilder().setCustomId(`claim_request:${requestId}`).setLabel('I\'ll handle this').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId('close_ticket').setLabel('Close ticket').setStyle(ButtonStyle.Secondary),
            );
          }

          await ticketChannel.send({
            embeds: [ticketEmbed],
            components: [new ActionRowBuilder().addComponents(actionComponents)],
          });

          ticketsCreated++;

          // Notify activators
          if (!autoAssigned) {
            notifyActivators(interaction.client, {
              gameName,
              gameAppId: gameAppId || 0,
              buyerId: claim.user_id,
              ticketChannelId: ticketChannel.id,
            }, availableActivators).catch(() => {});
          }
        }

        // DM the user
        const user = await interaction.client.users.fetch(claim.user_id).catch(() => null);
        if (user) {
          await user.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x57f287)
                .setTitle('🎉 Preorder Fulfilled!')
                .setDescription(
                  `Your preorder for **${preorder.game_name}** has been fulfilled! A ticket has been created for your activation.`
                )
                .setFooter({ text: `Preorder #${id}` })
                .setTimestamp(),
            ],
          }).catch(() => {});
          dmCount++;
        }
      } catch (err) {
        // Continue with other users even if one fails
      }
    }

    const spots = getPreorderSpots(id);
    logPreorderStatus({ preorderId: id, gameName: preorder.game_name, action: 'fulfilled', actor: interaction.user.id, spotsInfo: spots }).catch(() => {});

    // Close the forum thread
    if (preorder.thread_id) {
      try {
        const thread = await interaction.client.channels.fetch(preorder.thread_id).catch(() => null);
        if (thread) {
          await thread.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x57f287)
                .setTitle('🎉 Preorder Fulfilled!')
                .setDescription(`This preorder has been fulfilled! **${ticketsCreated}** activation ticket${ticketsCreated !== 1 ? 's' : ''} created.`)
                .setTimestamp(),
            ],
          });
          await thread.setLocked(true).catch(() => {});
          await thread.setArchived(true).catch(() => {});
        }
      } catch {}
    }

    return interaction.editReply({
      content: `✅ Preorder **#${id}** (${preorder.game_name}) **fulfilled**. Created **${ticketsCreated}** ticket${ticketsCreated !== 1 ? 's' : ''}, notified **${dmCount}** user${dmCount !== 1 ? 's' : ''}.`,
    });
  }

  if (sub === 'refill') {
    const id = interaction.options.getInteger('id');
    const newSpots = interaction.options.getInteger('spots') ?? null;
    const preorder = getPreorder(id);
    if (!preorder) return interaction.reply({ content: `Preorder #${id} not found.`, flags: MessageFlags.Ephemeral });
    if (preorder.status === 'open') return interaction.reply({ content: `Preorder #${id} is already open.`, flags: MessageFlags.Ephemeral });

    refillPreorder(id, newSpots);
    const spots = getPreorderSpots(id);

    // Update the forum post if it exists
    if (preorder.thread_id) {
      try {
        const thread = await interaction.client.channels.fetch(preorder.thread_id).catch(() => null);
        if (thread) {
          // Unarchive if archived
          if (thread.archived) await thread.setArchived(false).catch(() => {});
          if (thread.locked) await thread.setLocked(false).catch(() => {});
          const spotsText = spots?.unlimited ? 'Unlimited spots' : `**${spots?.remaining}** spots remaining`;
          await thread.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x9b59b6)
                .setTitle('🔄 Preorder Refilled!')
                .setDescription(`This preorder has been **reopened**!\n\n🎟️ ${spotsText}\n💰 Minimum donation: **$${preorder.price.toFixed(2)}**\n\nClick the claim button on the first message to reserve your spot.`)
                .setTimestamp(),
            ],
          });
        }
      } catch {}
    }

    logPreorderStatus({ preorderId: id, gameName: preorder.game_name, action: 'refilled', actor: interaction.user.id, spotsInfo: spots }).catch(() => {});

    const spotsText = newSpots !== null ? ` with ${newSpots === 0 ? 'unlimited' : newSpots} spots` : '';
    return interaction.reply({
      content: `✅ Preorder **#${id}** (${preorder.game_name}) has been **refilled** and is open again${spotsText}. ${spotsLabel(spots)}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
