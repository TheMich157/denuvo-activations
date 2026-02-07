import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { completeRequest, getRequest, getPendingRequestForChannel } from '../services/requests.js';
import { logActivation } from '../services/activationLog.js';
import { sendCooldownDM } from '../services/cooldownDM.js';
import { getCooldownHours, getGameByAppId, getGameDisplayName } from '../utils/games.js';
import { recordStreakActivity, getStreakInfo, getStreakBonus } from '../services/streaks.js';
import { addPoints } from '../services/points.js';

const VALIDITY_MINUTES = 30;

/**
 * Shared: complete the request with auth code, log, update ticket message, and send code embed to ticket.
 * Used by both manual "Done" modal and auto-generate flow.
 * @param {Object} req - Request row (must have id, ticket_channel_id, buyer_id, game_name, points_charged)
 * @param {string} authCode
 * @param {import('discord.js').Client} client
 * @returns {Promise<boolean>} - true if completed and sent
 */
export async function completeAndNotifyTicket(req, authCode, client) {
  const completed = completeRequest(req.id, authCode);
  if (!completed) return false;
  const updated = getRequest(req.id);
  if (updated) await logActivation(updated);

  const hours = getCooldownHours(req.game_app_id);
  const cooldownUntil = Date.now() + hours * 60 * 60 * 1000;
  const game = getGameByAppId(req.game_app_id);
  const gameName = game ? getGameDisplayName(game) : req.game_name;
  if (client) {
    sendCooldownDM(client, req.buyer_id, { gameName, cooldownUntil, hours }).catch(() => {});
  }

  // Streak tracking & bonus
  if (req.issuer_id) {
    recordStreakActivity(req.issuer_id);
    const streak = getStreakInfo(req.issuer_id);
    const bonus = getStreakBonus(streak.current);
    if (bonus > 0) {
      addPoints(req.issuer_id, bonus, 'streak_bonus', req.id);
    }
  }

  const ticketChannel = req.ticket_channel_id
    ? await client.channels.fetch(req.ticket_channel_id).catch(() => null)
    : null;
  if (!ticketChannel) return true;

  try {
    const fetched = await ticketChannel.messages.fetch({ limit: 20 });
    const mainMsg = fetched.find((m) => m.author.id === client.user.id && m.components?.length);
    if (mainMsg?.editable) {
      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('close_ticket').setLabel('Close ticket').setStyle(ButtonStyle.Secondary)
      );
      await mainMsg.edit({ components: [closeRow] });
    }
  } catch {}

  const expiresAt = Math.floor(Date.now() / 1000) + VALIDITY_MINUTES * 60;
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('✅ Authorization code ready')
    .setDescription(
      [
        `Here is your authorization code for **${req.game_name}**. Select the code below and copy it.`,
        '',
        '**If you have a problem with it, press Help** to request assistance.',
      ].join('\n')
    )
    .addFields(
      { name: 'Code', value: `\`\`\`\n${authCode}\n\`\`\``, inline: false },
      {
        name: '⏱️ Validity',
        value: `This code is valid for **${VALIDITY_MINUTES} minutes**. Expires <t:${expiresAt}:R> (<t:${expiresAt}:f>).`,
        inline: false,
      }
    )
    .addFields({ name: '📋 Status', value: 'Code ready', inline: true })
    .setFooter({ text: `Ticket #${req.id.slice(0, 8).toUpperCase()} • Copy code or press Help if you need assistance` });
  const copyRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`auth_copy:${req.id}`)
      .setLabel('📋 Copy code')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`auth_worked:${req.id}`)
      .setLabel('✓ Code worked')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('call_activator')
      .setLabel('Help')
      .setStyle(ButtonStyle.Secondary)
  );
  await ticketChannel.send({
    content: `<@${req.buyer_id}>`,
    embeds: [embed],
    components: [copyRow],
  });
  return true;
}

export async function handleButton(interaction) {
  if (!interaction.isButton() || interaction.customId !== 'done_request') return false;

  const req = getPendingRequestForChannel(interaction.channelId);
  if (!req) {
    await interaction.reply({ content: 'No active request in this channel.', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (req.issuer_id !== interaction.user.id) {
    await interaction.reply({ content: 'Only the assigned issuer can mark this as done.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const modal = new ModalBuilder()
    .setCustomId(`done_modal:${req.id}`)
    .setTitle('Enter authorization code');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('auth_code')
        .setLabel('Authorization code')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('Paste the code from drm.steam.run')
    )
  );

  await interaction.showModal(modal);
  return true;
}

export async function handleModal(interaction) {
  if (!interaction.isModalSubmit() || !interaction.customId.startsWith('done_modal:')) return false;
  const requestId = interaction.customId.split(':')[1];
  const authCode = interaction.fields.getTextInputValue('auth_code');

  const req = getRequest(requestId);
  if (!req || req.issuer_id !== interaction.user.id) {
    await interaction.reply({ content: 'Invalid or unauthorized.', flags: MessageFlags.Ephemeral });
    return true;
  }

  await completeAndNotifyTicket(req, authCode, interaction.client);

  await interaction.reply({
    content: `✅ **Activation completed.** Auth code sent to ticket. **${req.points_charged}** points transferred to you.`,
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

export async function handleCopyButton(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('auth_copy:')) return false;
  const requestId = interaction.customId.split(':')[1];
  const req = getRequest(requestId);
  if (!req?.auth_code) {
    await interaction.reply({ content: 'Code no longer available.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const isBuyer = interaction.user.id === req.buyer_id;
  const isIssuer = interaction.user.id === req.issuer_id;
  if (!isBuyer && !isIssuer) {
    await interaction.reply({ content: 'Only the buyer or issuer can copy the code.', flags: MessageFlags.Ephemeral });
    return true;
  }
  await interaction.reply({
    content: `**Authorization code for ${req.game_name}:**\n\`\`\`\n${req.auth_code}\n\`\`\`\nSelect the text above and copy (Ctrl+C).`,
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

export async function handleCodeWorkedButton(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('auth_worked:')) return false;
  const requestId = interaction.customId.split(':')[1];
  const req = getRequest(requestId);
  if (!req) return false;
  if (interaction.user.id !== req.buyer_id) {
    await interaction.reply({ content: 'Only the buyer can confirm the code worked.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('✅ Code confirmed')
    .setDescription(`<@${req.buyer_id}> confirmed the authorization code worked for **${req.game_name}**.`)
    .addFields({ name: '📋 Status', value: 'Completed ✓', inline: true })
    .setFooter({ text: `Ticket #${requestId.slice(0, 8).toUpperCase()}` })
    .setTimestamp();
  // Rating buttons
  const ratingRow = new ActionRowBuilder().addComponents(
    ...[1, 2, 3, 4, 5].map((n) =>
      new ButtonBuilder()
        .setCustomId(`rate_activator:${requestId}:${n}`)
        .setLabel('★'.repeat(n))
        .setStyle(n >= 4 ? ButtonStyle.Success : n >= 2 ? ButtonStyle.Primary : ButtonStyle.Secondary)
    )
  );
  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('close_ticket').setLabel('Close ticket').setStyle(ButtonStyle.Secondary)
  );
  await interaction.update({ embeds: [embed], components: [ratingRow, closeRow] });
  return true;
}

export async function handleRateButton(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('rate_activator:')) return false;
  const parts = interaction.customId.split(':');
  const requestId = parts[1];
  const rating = parseInt(parts[2], 10);
  const req = getRequest(requestId);
  if (!req) return false;
  if (interaction.user.id !== req.buyer_id) {
    await interaction.reply({ content: 'Only the buyer can rate.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const { submitRating, hasRated } = await import('../services/ratings.js');
  if (hasRated(requestId)) {
    await interaction.reply({ content: 'You already rated this activation.', flags: MessageFlags.Ephemeral });
    return true;
  }
  submitRating(requestId, req.issuer_id, req.buyer_id, rating);
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('✅ Code confirmed & rated')
    .setDescription(
      `<@${req.buyer_id}> confirmed the code worked for **${req.game_name}** and rated <@${req.issuer_id}> ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}.`
    )
    .addFields({ name: '📋 Status', value: 'Completed ✓', inline: true })
    .setFooter({ text: `Ticket #${requestId.slice(0, 8).toUpperCase()}` })
    .setTimestamp();
  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('close_ticket').setLabel('Close ticket').setStyle(ButtonStyle.Secondary)
  );
  await interaction.update({ embeds: [embed], components: [closeRow] });
  return true;
}
