import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { debug } from '../utils/debug.js';
import { isActivator } from '../utils/activator.js';

const log = debug('interaction');
import { assignIssuer, getRequest, getRequestByChannel, cancelRequest, markScreenshotVerified } from '../services/requests.js';
import { saveTranscript } from '../services/transcript.js';
import { getCredentials } from '../services/activators.js';
import { setState, clearState } from '../services/screenshotVerify/state.js';
import { generateAuthCode, generateAuthCodeForRequest, DrmError } from '../services/drm.js';
import { completeAndNotifyTicket } from '../commands/done.js';
import { handleSelect as panelHandleSelect, handleRefresh as panelHandleRefresh } from '../commands/panelHandler.js';
import { handleSelect as addHandleSelect, handleModal as addHandleModal } from '../commands/add.js';
import { handleButton as doneHandleButton, handleModal as doneHandleModal, handleCopyButton as doneHandleCopyButton, handleCodeWorkedButton, handleRateButton } from '../commands/done.js';
import { handleButton as invalidHandleButton } from '../commands/invalid.js';
import { handleButton as callModHandleButton } from '../commands/call_mod.js';
import { handleButton as transferHandleButton } from '../commands/transfer.js';
import { sendStatusDM } from '../services/statusNotify.js';
import { getPreorder, submitClaim, getClaim, verifyClaim, getPreorderSpots, isPreorderFull, closePreorder, removeClaim, formatSpotsText, buildPreorderEmbed } from '../services/preorder.js';
import { config } from '../config.js';
import {
  logPreorderClaim,
  logPreorderVerify,
  logPreorderReject,
  logPreorderStatus,
  logFeedback,
} from '../services/activationLog.js';
import { getGiveaway, hasEntered, enterGiveaway, leaveGiveaway, getEntryCount } from '../services/giveaway.js';
import { createTicketForGame } from '../services/ticket.js';
import { submitFeedback, hasFeedback } from '../services/feedback.js';
import { handleBulkCodeModal } from '../commands/bulkcode.js';
import { handleModal as bulkdoneHandleModal } from '../commands/bulkdone.js';
import { getUserTierInfo, TIERS, getDiscountedPrice } from '../services/tiers.js';
import { handleVerifyAnswer, handleVerifyRetry } from '../services/verification.js';
import { handleAppealModal } from '../commands/appeal.js';
import { isBlacklisted } from '../services/blacklist.js';

function buildIssuerActionRow(requestId, hasAutomated = false) {
  const components = [
    new ButtonBuilder()
      .setCustomId('done_request')
      .setLabel('Done – enter auth code')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('call_activator')
      .setLabel('Help')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('close_ticket')
      .setLabel('Close ticket')
      .setStyle(ButtonStyle.Secondary),
  ];
  if (hasAutomated) {
    components.unshift(
      new ButtonBuilder()
        .setCustomId(`auto_code:${requestId}`)
        .setLabel('Get code automatically')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('⚡')
    );
  }
  return new ActionRowBuilder().addComponents(components);
}

async function handleClaimRequest(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('claim_request:')) return false;
  const requestId = interaction.customId.split(':')[1];
  const result = assignIssuer(requestId, interaction.user.id);
  if (!result.ok) {
    await interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
    return true;
  }
  const req = getRequest(requestId);
  const channel = interaction.channel;
  if (channel?.guild && req.ticket_channel_id === channel.id) {
    await channel.permissionOverwrites.set([
      { id: channel.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: req.buyer_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: req.issuer_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    ]);
  }
  // Check if this activator has credentials, OR if any automated account exists for this game
  let hasAutomated = !!getCredentials(req.issuer_id, req.game_app_id);
  if (!hasAutomated) {
    try {
      const { getActivatorsForGame } = await import('../services/activators.js');
      const activators = getActivatorsForGame(req.game_app_id, true);
      hasAutomated = activators.some(a => a.method === 'automated' && a.steam_username);
    } catch {}
  }
  const ticketRef = `#${req.id.slice(0, 8).toUpperCase()}`;
  const claimedEmbed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`✅ Claimed: ${req.game_name}`)
    .setDescription(
      [
        `**Requester:** <@${req.buyer_id}>`,
        `**Assigned activator:** <@${req.issuer_id}>`,
        '',
        hasAutomated
          ? '**Automatic:** Use **Get code automatically** (enter the confirmation code from your email when asked). **Manual:** Use **Done** to paste the code from drm.steam.run yourself. Press **Help** if you need assistance.'
          : 'Use **Done** to enter the auth code from drm.steam.run (manual method). Press **Help** if you need assistance.',
      ].join('\n')
    )
    .addFields({ name: '📋 Status', value: 'In progress — awaiting auth code', inline: true })
    .setFooter({ text: `Ticket ${ticketRef} • Screenshot must be verified before completing` })
    .setTimestamp();

  await interaction.update({
    content: null,
    embeds: [claimedEmbed],
    components: [buildIssuerActionRow(requestId, hasAutomated)],
  });
  // DM buyer that request was claimed
  sendStatusDM(interaction.client, req.buyer_id, 'claimed', { gameName: req.game_name }).catch(() => {});
  return true;
}

async function handleAutoCodeButton(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('auto_code:')) return false;
  const requestId = interaction.customId.slice('auto_code:'.length);
  const req = getRequest(requestId);
  if (!req || req.issuer_id !== interaction.user.id) {
    await interaction.reply({ content: 'Invalid or unauthorized.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const credentials = getCredentials(req.issuer_id, req.game_app_id);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const ticketChannel = req.ticket_channel_id
    ? await interaction.client.channels.fetch(req.ticket_channel_id).catch(() => null)
    : null;
  if (ticketChannel?.send) {
    await ticketChannel.send({
      content: `⏳ **Generating your code...** This may take a moment.`,
    }).catch(() => {});
  }

  try {
    // Use specific activator credentials if available, otherwise search DB for any automated account
    const code = credentials
      ? await generateAuthCode(req.game_app_id, credentials, null)
      : await generateAuthCodeForRequest(req.game_app_id, null);
    const result = await completeAndNotifyTicket(req, code, interaction.client);
    if (result === 'screenshot_not_verified') {
      await interaction.editReply({
        content: '❌ **Cannot complete** — the buyer\'s screenshot has not been verified yet. Verify it first, then try again.',
      });
      return true;
    }
    await interaction.editReply({
      content: `✅ **Code generated and sent to the ticket.** **${req.points_charged}** points transferred to you.`,
    });
  } catch (err) {
    const msg = err?.message || 'Generation failed.';
    if (msg.includes('Confirmation code')) {
      await interaction.editReply({
        content: '📧 **Steam sent a confirmation code to your email.** Enter the 5-digit code below.',
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`auto_code_2fa:${requestId}`)
              .setLabel('Enter confirmation code')
              .setStyle(ButtonStyle.Primary)
          ),
        ],
      });
    } else {
      if (err instanceof DrmError) {
        console.error('[DRM Auto-Code]', err.toDiagnostic());
      }
      await interaction.editReply({
        content: `❌ **Could not generate code.** ${msg} You can use **Done** to paste the code from drm.steam.run manually.`,
      });
    }
  }
  return true;
}

async function handleAutoCode2FAButton(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('auto_code_2fa:')) return false;
  const requestId = interaction.customId.slice('auto_code_2fa:'.length);
  const req = getRequest(requestId);
  if (!req || req.issuer_id !== interaction.user.id) {
    await interaction.reply({ content: 'Invalid or unauthorized.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const credentials = getCredentials(req.issuer_id, req.game_app_id);
  if (!credentials) {
    await interaction.reply({ content: 'Automated credentials not available. Use **Done** and enter the code manually.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const modal = new ModalBuilder()
    .setCustomId(`auto_code_modal:${requestId}`)
    .setTitle('Confirmation code');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('twofactor')
        .setLabel('Confirmation code (from email)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('5-digit code Steam sent to your email')
        .setMinLength(5)
        .setMaxLength(8)
    )
  );
  await interaction.showModal(modal);
  return true;
}

async function handleAutoCodeModal(interaction) {
  if (!interaction.isModalSubmit() || !interaction.customId.startsWith('auto_code_modal:')) return false;
  const requestId = interaction.customId.slice('auto_code_modal:'.length);
  const twoFactorCode = interaction.fields.getTextInputValue('twofactor').trim();
  const req = getRequest(requestId);
  if (!req || req.issuer_id !== interaction.user.id) {
    await interaction.reply({ content: 'Invalid or unauthorized.', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (req.status !== 'in_progress') {
    await interaction.reply({ content: 'This request is no longer in progress.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const credentials = getCredentials(req.issuer_id, req.game_app_id);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const ticketChannel = req.ticket_channel_id
    ? await interaction.client.channels.fetch(req.ticket_channel_id).catch(() => null)
    : null;
  if (ticketChannel?.send) {
    await ticketChannel.send({
      content: `⏳ **Generating your code...** (this may take a moment). You'll get the code here as soon as it's ready.`,
    }).catch(() => {});
  }

  try {
    const code = credentials
      ? await generateAuthCode(req.game_app_id, credentials, twoFactorCode)
      : await generateAuthCodeForRequest(req.game_app_id, twoFactorCode);
    const result = await completeAndNotifyTicket(req, code, interaction.client);
    if (result === 'screenshot_not_verified') {
      await interaction.editReply({
        content: '❌ **Cannot complete** — the buyer\'s screenshot has not been verified yet. Verify it first, then try again.',
      });
      return true;
    }
    await interaction.editReply({
      content: `✅ **Code generated and sent to the ticket.** **${req.points_charged}** points transferred to you.`,
    });
  } catch (err) {
    const msg = err?.message || 'Generation failed.';
    if (err instanceof DrmError) {
      console.error('[DRM Auto-Code 2FA]', err.toDiagnostic());
    }
    await interaction.editReply({
      content: `❌ **Could not generate code.** ${msg} You can use **Done** to paste the code from drm.steam.run manually.`,
    });
  }
  return true;
}

async function handleManualVerifyScreenshot(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('manual_verify_screenshot:')) return false;
  const req = getRequestByChannel(interaction.channelId);
  if (!req) {
    await interaction.reply({ content: 'No ticket found for this channel.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const isIssuer = req.issuer_id && interaction.user.id === req.issuer_id;
  const activator = isActivator(interaction.member);
  if (!isIssuer && !activator) {
    await interaction.reply({
      content: 'Only the assigned activator or an activator can approve manually.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  markScreenshotVerified(req.id);
  setState(interaction.channelId, {
    hasProperties: true,
    hasWub: true,
    failCount: 0,
    manualVerified: true,
  });
  const ticketRef = `#${req.id.slice(0, 8).toUpperCase()}`;
  const approvedEmbed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('✅ Screenshot manually approved')
    .setDescription(
      `Approved by <@${interaction.user.id}>. Ready for activator to claim.`
    )
    .addFields({ name: '📋 Status', value: 'Verified — ready to claim', inline: true })
    .setFooter({ text: `Ticket ${ticketRef}` })
    .setTimestamp();
  await interaction.update({
    content: null,
    embeds: [approvedEmbed],
    components: [],
  });
  return true;
}

async function handleCloseTicket(interaction) {
  if (!interaction.isButton() || interaction.customId !== 'close_ticket') return false;
  const req = getRequestByChannel(interaction.channelId);
  if (!req) {
    await interaction.reply({ content: 'No ticket found for this channel.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const isBuyer = interaction.user.id === req.buyer_id;
  const isIssuer = req.issuer_id && interaction.user.id === req.issuer_id;
  if (!isBuyer && !isIssuer) {
    await interaction.reply({ content: 'Only the buyer or assigned activator can close this ticket.', flags: MessageFlags.Ephemeral });
    return true;
  }
  // Save transcript before closing
  await saveTranscript(interaction.client, interaction.channelId, req.id, 'cancelled').catch(() => {});
  cancelRequest(req.id);
  clearState(interaction.channelId);
  // DM buyer about cancellation
  if (interaction.user.id !== req.buyer_id) {
    sendStatusDM(interaction.client, req.buyer_id, 'cancelled', { gameName: req.game_name }).catch(() => {});
  }
  const channel = interaction.channel;
  if (channel?.deletable) {
    await interaction.reply({ content: 'Closing ticket...', flags: MessageFlags.Ephemeral });
    await channel.delete();
  } else {
    await interaction.reply({ content: 'Ticket cancelled. I cannot delete this channel.', flags: MessageFlags.Ephemeral });
  }
  return true;
}

/**
 * Update the original preorder forum post embed with the latest spot counts.
 */
async function updatePreorderForumEmbed(client, preorder, preorderId) {
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

async function handleTipVerifyButton(interaction) {
  if (!interaction.isButton()) return false;
  const isVerify = interaction.customId.startsWith('verify_tip:');
  const isReject = interaction.customId.startsWith('reject_tip:');
  if (!isVerify && !isReject) return false;

  // Only activators can verify/reject tips
  if (!isActivator(interaction.member)) {
    await interaction.reply({ content: 'Only activators can verify or reject tips.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const parts = interaction.customId.split(':');
  const preorderId = parseInt(parts[1], 10);
  const userId = parts[2];

  const preorder = getPreorder(preorderId);
  if (!preorder) {
    await interaction.reply({ content: `Preorder #${preorderId} not found.`, flags: MessageFlags.Ephemeral });
    return true;
  }

  if (isVerify) {
    // Check if preorder is full before verifying
    if (isPreorderFull(preorderId)) {
      await interaction.reply({ content: `All spots for preorder **#${preorderId}** are already filled. Cannot verify.`, flags: MessageFlags.Ephemeral });
      return true;
    }

    // Ensure claim exists (create if user posted proof without clicking the button)
    const existing = getClaim(preorderId, userId);
    if (!existing) {
      submitClaim(preorderId, userId);
    }
    verifyClaim(preorderId, userId);

    const spots = getPreorderSpots(preorderId);
    const spotsText = formatSpotsText(spots);

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅ Tip Verified — Spot Confirmed')
      .setDescription(`<@${userId}>'s tip for preorder **#${preorderId}** (${preorder.game_name}) has been manually verified by <@${interaction.user.id}>.\nTheir spot is now **confirmed**.`)
      .addFields({ name: '🎟️ Spots', value: spotsText, inline: true })
      .setTimestamp();
    await interaction.update({ embeds: [embed], components: [] });

    // DM the user
    try {
      const user = await interaction.client.users.fetch(userId).catch(() => null);
      if (user) {
        await user.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x57f287)
              .setTitle('✅ Spot Confirmed!')
              .setDescription(
                [
                  `Your donation for preorder **#${preorderId}** (${preorder.game_name}) has been **verified**!`,
                  '',
                  '**Your spot is now confirmed.** You\'ll receive a DM when the preorder is fulfilled and your activation is ready.',
                  '',
                  `🎟️ ${spotsText}`,
                ].join('\n')
              )
              .setFooter({ text: `Preorder #${preorderId}` })
              .setTimestamp(),
          ],
        }).catch(() => {});
      }
    } catch {}

    // Log
    logPreorderVerify({ preorderId, gameName: preorder.game_name, userId, amount: null, method: 'manual', verifiedBy: interaction.user.id }).catch(() => {});

    // Update forum post embed with new spot counts
    await updatePreorderForumEmbed(interaction.client, preorder, preorderId);

    // Notify thread
    if (preorder.thread_id) {
      try {
        const thread = await interaction.client.channels.fetch(preorder.thread_id).catch(() => null);
        if (thread) {
          await thread.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x57f287)
                .setDescription(`✅ <@${userId}>'s tip manually verified — spot confirmed!\n🎟️ ${spotsText}`)
                .setTimestamp(),
            ],
          });
        }
      } catch {}
    }

    // Auto-close if all spots filled
    if (isPreorderFull(preorderId)) {
      closePreorder(preorderId);
      logPreorderStatus({ preorderId, gameName: preorder.game_name, action: 'closed', actor: interaction.client.user.id, spotsInfo: spots }).catch(() => {});
      await updatePreorderForumEmbed(interaction.client, { ...preorder, status: 'closed' }, preorderId);
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
  } else {
    // Reject — release the pending claim so the spot is freed
    removeClaim(preorderId, userId);

    const spots = getPreorderSpots(preorderId);
    const spotsText = formatSpotsText(spots);

    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('❌ Tip Rejected — Spot Released')
      .setDescription(`<@${userId}>'s tip proof for preorder **#${preorderId}** was rejected by <@${interaction.user.id}>.\nTheir reserved spot has been **released**.`)
      .addFields({ name: '🎟️ Spots', value: spotsText, inline: true })
      .setTimestamp();
    await interaction.update({ embeds: [embed], components: [] });

    // Log
    logPreorderReject({ preorderId, gameName: preorder.game_name, userId, rejectedBy: interaction.user.id }).catch(() => {});

    // Update forum post
    await updatePreorderForumEmbed(interaction.client, preorder, preorderId);

    // DM the user
    try {
      const user = await interaction.client.users.fetch(userId).catch(() => null);
      if (user) {
        await user.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xed4245)
              .setTitle('❌ Tip Proof Rejected — Spot Released')
              .setDescription(
                [
                  `Your tip proof for preorder **#${preorderId}** (${preorder.game_name}) was rejected.`,
                  'Your reserved spot has been **released**.',
                  '',
                  `Please submit a clearer screenshot of your Ko-fi donation receipt (minimum $${getDiscountedPrice(preorder.price, userId).toFixed(2)}).`,
                  'You can click **"Reserve Spot"** again on the preorder post after re-donating.',
                ].join('\n')
              )
              .setTimestamp(),
          ],
        }).catch(() => {});
      }
    } catch {}
  }

  return true;
}

async function handlePreorderClaim(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('preorder_claim:')) return false;

  // Blacklist guard
  if (isBlacklisted(interaction.user.id)) {
    await interaction.reply({ content: 'You are blacklisted and cannot reserve preorder spots.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const preorderId = parseInt(interaction.customId.split(':')[1], 10);
  const preorder = getPreorder(preorderId);
  if (!preorder || preorder.status !== 'open') {
    await interaction.reply({ content: 'This preorder is no longer open.', flags: MessageFlags.Ephemeral });
    return true;
  }

  // Check if spots are full (based on verified claims)
  if (isPreorderFull(preorderId)) {
    await interaction.reply({ content: `All spots for preorder **#${preorderId}** (${preorder.game_name}) are filled. Check back later or look for a refill!`, flags: MessageFlags.Ephemeral });
    return true;
  }

  // Check if user already has a claim
  const existing = getClaim(preorderId, interaction.user.id);
  if (existing) {
    const status = existing.verified ? '✅ **Verified**' : '⏳ **Pending verification**';
    const hint = existing.verified
      ? 'You\'ll be notified when the preorder is fulfilled!'
      : `Post your Ko-fi receipt screenshot in <#${config.tipVerifyChannelId || 'tip-verify'}> with **#${preorderId}** to verify.`;
    await interaction.reply({
      content: `You already have a spot reserved on preorder **#${preorderId}** (${preorder.game_name}).\nStatus: ${status}\n\n${hint}`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  // Reserve the spot (pending verification)
  submitClaim(preorderId, interaction.user.id);
  const spots = getPreorderSpots(preorderId);
  const spotsText = formatSpotsText(spots);

  // Log the claim
  logPreorderClaim({ preorderId, gameName: preorder.game_name, userId: interaction.user.id, spotsInfo: spots }).catch(() => {});

  // Tier-based discount on preorder price
  const tierInfo = getUserTierInfo(interaction.user.id);
  const discountedPrice = getDiscountedPrice(preorder.price, interaction.user.id);
  const priceDisplay = discountedPrice < preorder.price
    ? `~~$${preorder.price.toFixed(2)}~~ **$${discountedPrice.toFixed(2)}** (${tierInfo.emoji} ${Math.round(TIERS[tierInfo.tier].preorderDiscount * 100)}% tier discount!)`
    : `**$${preorder.price.toFixed(2)}**`;

  const embed = new EmbedBuilder()
    .setColor(0xe91e63)
    .setTitle('🎟️ Spot Reserved — Verification Required')
    .setDescription(
      [
        `Your spot for **${preorder.game_name}** (Preorder #${preorderId}) has been **reserved**!`,
        '',
        `🎟️ **Spots:** ${spotsText}`,
        '',
        '**⚠️ You must verify your donation to confirm your spot.** Follow these steps:',
        '',
        `1. Donate at least ${priceDisplay} on [Ko-fi](${config.kofiUrl})`,
        `2. Take a **screenshot** of your Ko-fi receipt`,
        `3. Post the screenshot in <#${config.tipVerifyChannelId || 'tip-verify'}>`,
        `4. Include **"#${preorderId}"** in your message`,
        '5. The bot will auto-verify and **confirm your spot**!',
        '',
        '> ⏰ Unverified spots may be released after 48 hours.',
      ].join('\n')
    )
    .setFooter({ text: `Preorder #${preorderId} • Verify within 48 hours` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

  // DM the user
  try {
    await interaction.user.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xe91e63)
          .setTitle('🎟️ Preorder Spot Reserved!')
          .setDescription(
            [
              `You reserved a spot for **${preorder.game_name}** (Preorder #${preorderId}).`,
              '',
              `💰 **Donate at least ${priceDisplay}** on [Ko-fi](${config.kofiUrl})`,
              config.tipVerifyChannelId
                ? `📸 **Post your receipt** in <#${config.tipVerifyChannelId}> with \`#${preorderId}\``
                : `📸 **Post your receipt** in the tip verification channel with \`#${preorderId}\``,
              '',
              `🎟️ ${spotsText}`,
              '',
              '> ⏰ Your spot must be verified within 48 hours or it may be released.',
            ].join('\n')
          )
          .setFooter({ text: `Preorder #${preorderId}` })
          .setTimestamp(),
      ],
    }).catch(() => {});
  } catch {}

  // Update forum post with new spot counts
  await updatePreorderForumEmbed(interaction.client, preorder, preorderId);

  // Notify the forum thread
  if (preorder.thread_id) {
    try {
      const thread = await interaction.client.channels.fetch(preorder.thread_id).catch(() => null);
      if (thread) {
        await thread.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x3498db)
              .setDescription(`🎟️ <@${interaction.user.id}> reserved a spot! (pending verification)\n${spotsText}`)
              .setTimestamp(),
          ],
        });
      }
    } catch {}
  }

  return true;
}

async function handleGiveawayEnter(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('giveaway_enter:')) return false;

  // Blacklist guard
  if (isBlacklisted(interaction.user.id)) {
    await interaction.reply({ content: 'You are blacklisted and cannot enter giveaways.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const giveawayId = parseInt(interaction.customId.split(':')[1], 10);
  const giveaway = getGiveaway(giveawayId);
  if (!giveaway) {
    await interaction.reply({ content: 'Giveaway not found.', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (giveaway.status === 'ended') {
    await interaction.reply({ content: 'This giveaway has already ended.', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (new Date(giveaway.ends_at) < new Date()) {
    await interaction.reply({ content: 'This giveaway has expired.', flags: MessageFlags.Ephemeral });
    return true;
  }

  // Toggle: if already entered, leave; otherwise enter
  if (hasEntered(giveawayId, interaction.user.id)) {
    leaveGiveaway(giveawayId, interaction.user.id);
    const count = getEntryCount(giveawayId);
    await interaction.reply({ content: `❌ You left the giveaway for **${giveaway.game_name}**. Press again to re-enter. (${count} entries)`, flags: MessageFlags.Ephemeral });

    // Update entry count on message
    if (giveaway.message_id && giveaway.channel_id) {
      try {
        const ch = await interaction.client.channels.fetch(giveaway.channel_id).catch(() => null);
        if (ch) {
          const msg = await ch.messages.fetch(giveaway.message_id).catch(() => null);
          if (msg?.embeds?.[0]) {
            const updated = EmbedBuilder.from(msg.embeds[0])
              .setFooter({ text: `Giveaway #${giveawayId} • ${count} entries` });
            await msg.edit({ embeds: [updated] }).catch(() => {});
          }
        }
      } catch {}
    }
    return true;
  }

  enterGiveaway(giveawayId, interaction.user.id);
  const count = getEntryCount(giveawayId);
  await interaction.reply({ content: `🎉 You've entered the giveaway for **${giveaway.game_name}**! Press again to leave. (${count} total entries)`, flags: MessageFlags.Ephemeral });

  // Update the giveaway message entry count
  if (giveaway.message_id && giveaway.channel_id) {
    try {
      const ch = await interaction.client.channels.fetch(giveaway.channel_id).catch(() => null);
      if (ch) {
        const msg = await ch.messages.fetch(giveaway.message_id).catch(() => null);
        if (msg?.embeds?.[0]) {
          const updated = EmbedBuilder.from(msg.embeds[0])
            .setFooter({ text: `Giveaway #${giveawayId} • ${count} entries` });
          await msg.edit({ embeds: [updated] }).catch(() => {});
        }
      }
    } catch {}
  }
  return true;
}

async function handleGiveawayClaim(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('giveaway_claim:')) return false;

  const giveawayId = parseInt(interaction.customId.split(':')[1], 10);
  const giveaway = getGiveaway(giveawayId);
  if (!giveaway) {
    await interaction.reply({ content: 'Giveaway not found.', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (giveaway.status !== 'ended') {
    await interaction.reply({ content: 'This giveaway hasn\'t ended yet.', flags: MessageFlags.Ephemeral });
    return true;
  }

  // Only winners can claim
  let winners = [];
  try { winners = JSON.parse(giveaway.winners || '[]'); } catch {}
  if (!winners.includes(interaction.user.id)) {
    await interaction.reply({ content: '❌ Only giveaway winners can claim the prize.', flags: MessageFlags.Ephemeral });
    return true;
  }

  // Check if game has an app ID for ticket creation
  if (!giveaway.game_app_id) {
    await interaction.reply({
      content: `🎉 You won **${giveaway.game_name}**! No App ID was set for this giveaway — please contact <@${giveaway.created_by}> directly for your activation.`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Create a ticket with the giveaway creator as the assigned issuer
  const result = await createTicketForGame(interaction, giveaway.game_app_id, { preorder: true });
  if (!result.ok) {
    await interaction.editReply({ content: `❌ Could not create ticket: ${result.error}` });
    return true;
  }

  const ticketChannel = result.channel;
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🎁 Giveaway Prize Claimed!')
    .setDescription(
      [
        `<@${interaction.user.id}> won **${giveaway.game_name}** in Giveaway #${giveawayId}!`,
        '',
        `**Hosted by:** <@${giveaway.created_by}>`,
        ticketChannel ? `**Ticket:** <#${ticketChannel.id}>` : '',
      ].filter(Boolean).join('\n')
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  // Notify the ticket channel
  if (ticketChannel) {
    try {
      await ticketChannel.send({
        content: `<@${giveaway.created_by}>`,
        embeds: [
          new EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle('🎁 Giveaway Winner Ticket')
            .setDescription(
              [
                `<@${interaction.user.id}> won **${giveaway.game_name}** in Giveaway #${giveawayId}.`,
                '',
                `Please provide the activation code for this user.`,
              ].join('\n')
            )
            .setTimestamp(),
        ],
        allowedMentions: { users: [giveaway.created_by] },
      });
    } catch {}
  }

  return true;
}

async function handleFeedbackButton(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('feedback:')) return false;

  const parts = interaction.customId.split(':');
  const requestId = parts[1];
  const rating = parseInt(parts[2], 10);

  if (hasFeedback(requestId)) {
    await interaction.reply({ content: 'You already submitted feedback for this ticket. Thanks!', flags: MessageFlags.Ephemeral });
    return true;
  }

  submitFeedback(requestId, interaction.user.id, rating);

  const stars = '⭐'.repeat(rating) + '☆'.repeat(5 - rating);

  // Update the DM embed to show the submitted rating (disable buttons)
  const confirmedEmbed = new EmbedBuilder()
    .setColor(rating >= 4 ? 0x57f287 : rating >= 2 ? 0xfee75c : 0xed4245)
    .setTitle('📝 Feedback Submitted — Thank You!')
    .setDescription(`You rated your experience: ${stars} **(${rating}/5)**\n\nYour feedback helps us improve the service!`)
    .setFooter({ text: `Ticket #${requestId.slice(0, 8).toUpperCase()}` })
    .setTimestamp();

  await interaction.update({ embeds: [confirmedEmbed], components: [] }).catch(async () => {
    // Fallback if update fails (e.g. message too old)
    await interaction.reply({ content: `Thanks for your feedback! ${stars} (${rating}/5)`, flags: MessageFlags.Ephemeral }).catch(() => {});
  });

  // Log feedback to the log channel
  const req = getRequest(requestId);
  logFeedback({
    requestId,
    userId: interaction.user.id,
    rating,
    gameName: req?.game_name || null,
    issuerId: req?.issuer_id || null,
  }).catch(() => {});

  // Also post to review channel if configured
  if (config.reviewChannelId && req) {
    try {
      const reviewChannel = await interaction.client.channels.fetch(config.reviewChannelId).catch(() => null);
      if (reviewChannel) {
        const reviewEmbed = new EmbedBuilder()
          .setColor(rating >= 4 ? 0x57f287 : rating >= 2 ? 0xfee75c : 0xed4245)
          .setAuthor({
            name: `Feedback by ${interaction.user.displayName || interaction.user.username}`,
            iconURL: interaction.user.displayAvatarURL({ size: 64 }),
          })
          .setTitle(`${stars}  (${rating}/5)`)
          .addFields(
            { name: '🎮 Game', value: req.game_name || '—', inline: true },
            { name: '🛠️ Activator', value: req.issuer_id ? `<@${req.issuer_id}>` : '—', inline: true },
          )
          .setFooter({ text: `Ticket #${requestId.slice(0, 8).toUpperCase()} • DM Feedback` })
          .setTimestamp();
        await reviewChannel.send({ embeds: [reviewEmbed] });
      }
    } catch {}
  }

  return true;
}

export async function handle(interaction) {
  log(interaction.constructor.name, interaction.customId ?? interaction.commandName ?? '—');
  const handlers = [
    handleVerifyAnswer,
    handleVerifyRetry,
    handleManualVerifyScreenshot,
    handleCloseTicket,
    handleClaimRequest,
    handleAutoCodeButton,
    handleAutoCode2FAButton,
    handleAutoCodeModal,
    handlePreorderClaim,
    handleTipVerifyButton,
    handleGiveawayEnter,
    handleGiveawayClaim,
    handleFeedbackButton,
    handleBulkCodeModal,
    bulkdoneHandleModal,
    handleAppealModal,
    doneHandleCopyButton,
    handleCodeWorkedButton,
    handleRateButton,
    panelHandleSelect,
    panelHandleRefresh,
    addHandleSelect,
    addHandleModal,
    doneHandleButton,
    doneHandleModal,
    invalidHandleButton,
    callModHandleButton,
    transferHandleButton,
  ];
  for (const h of handlers) {
    const handled = await h(interaction);
    if (handled) return;
  }
}
