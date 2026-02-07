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
import { generateAuthCode } from '../services/drm.js';
import { completeAndNotifyTicket } from '../commands/done.js';
import { handleSelect as panelHandleSelect, handleRefresh as panelHandleRefresh } from '../commands/panelHandler.js';
import { handleSelect as addHandleSelect, handleModal as addHandleModal } from '../commands/add.js';
import { handleButton as doneHandleButton, handleModal as doneHandleModal, handleCopyButton as doneHandleCopyButton, handleCodeWorkedButton, handleRateButton } from '../commands/done.js';
import { handleButton as invalidHandleButton } from '../commands/invalid.js';
import { handleButton as callModHandleButton } from '../commands/call_mod.js';
import { handleButton as transferHandleButton } from '../commands/transfer.js';

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
  const hasAutomated = !!getCredentials(req.issuer_id, req.game_app_id);
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
          ? '**Automatic:** Use **Get code automatically** (enter 2FA when asked). **Manual:** Use **Done** to paste the code from drm.steam.run yourself. Press **Help** if you need assistance.'
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
  if (!credentials) {
    await interaction.reply({ content: 'Automated credentials not found for this game. Use **Done** to enter the code manually.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const modal = new ModalBuilder()
    .setCustomId(`auto_code_modal:${requestId}`)
    .setTitle('Steam Guard code');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('twofactor')
        .setLabel('Current 2FA code')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('6-digit code from Steam Guard / Authenticator')
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
  if (!credentials) {
    await interaction.reply({ content: 'Automated credentials not available. Use **Done** and enter the code manually.', flags: MessageFlags.Ephemeral });
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const code = await generateAuthCode(req.game_app_id, credentials, twoFactorCode);
    await completeAndNotifyTicket(req, code, interaction.client);
    await interaction.editReply({
      content: `✅ **Code generated and sent to the ticket.** **${req.points_charged}** points transferred to you.`,
    });
  } catch (err) {
    const msg = err?.message || 'Generation failed.';
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
  await saveTranscript(interaction.client, interaction.channelId, req.id).catch(() => {});
  cancelRequest(req.id);
  clearState(interaction.channelId);
  const channel = interaction.channel;
  if (channel?.deletable) {
    await interaction.reply({ content: 'Closing ticket...', flags: MessageFlags.Ephemeral });
    await channel.delete();
  } else {
    await interaction.reply({ content: 'Ticket cancelled. I cannot delete this channel.', flags: MessageFlags.Ephemeral });
  }
  return true;
}

export async function handle(interaction) {
  log(interaction.constructor.name, interaction.customId ?? interaction.commandName ?? '—');
  const handlers = [
    handleManualVerifyScreenshot,
    handleCloseTicket,
    handleClaimRequest,
    handleAutoCodeButton,
    handleAutoCodeModal,
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
