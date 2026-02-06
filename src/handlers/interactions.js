import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { debug } from '../utils/debug.js';
import { isActivator } from '../utils/activator.js';

const log = debug('interaction');
import { assignIssuer, getRequest, getRequestByChannel, cancelRequest, markScreenshotVerified } from '../services/requests.js';
import { setState, clearState } from '../services/screenshotVerify/state.js';
import { handleSelect as panelHandleSelect, handleRefresh as panelHandleRefresh } from '../commands/panelHandler.js';
import { handleSelect as addHandleSelect, handleModal as addHandleModal } from '../commands/add.js';
import { handleButton as doneHandleButton, handleModal as doneHandleModal, handleCopyButton as doneHandleCopyButton } from '../commands/done.js';
import { handleButton as invalidHandleButton } from '../commands/invalid.js';
import { handleButton as callModHandleButton } from '../commands/call_mod.js';

function buildIssuerActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('done_request')
      .setLabel('Done – enter auth code')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('invalid_token')
      .setLabel('Invalid token')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('call_activator')
      .setLabel('Call activator')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('close_ticket')
      .setLabel('Close ticket')
      .setStyle(ButtonStyle.Secondary)
  );
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
  const claimedEmbed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`✅ Claimed: ${req.game_name}`)
    .setDescription(
      [
        `**Requester:** <@${req.buyer_id}>`,
        `**Assigned activator:** <@${req.issuer_id}>`,
        '',
        'Use **Done** to submit the auth code, or **Invalid token** if the code failed.',
      ].join('\n')
    )
    .setFooter({ text: 'Screenshot must be verified before completing' })
    .setTimestamp();

  await interaction.update({
    content: null,
    embeds: [claimedEmbed],
    components: [buildIssuerActionRow()],
  });
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
  const approvedEmbed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('✅ Screenshot manually approved')
    .setDescription(
      `Approved by <@${interaction.user.id}>. Ready for activator to claim.`
    )
    .setFooter({ text: 'Manual verification' })
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
    doneHandleCopyButton,
    panelHandleSelect,
    panelHandleRefresh,
    addHandleSelect,
    addHandleModal,
    doneHandleButton,
    doneHandleModal,
    invalidHandleButton,
    callModHandleButton,
  ];
  for (const h of handlers) {
    const handled = await h(interaction);
    if (handled) return;
  }
}
