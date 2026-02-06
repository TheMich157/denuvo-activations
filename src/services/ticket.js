import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
} from 'discord.js';
import { createRequest, setTicketChannel } from './requests.js';
import { getActivatorsForGame } from './activators.js';
import { getGameByAppId } from '../utils/games.js';
import { config } from '../config.js';
import { isValidAppId } from '../utils/validate.js';

const SCREENSHOT_INSTRUCTIONS = [
  '**📸 Required before activation**',
  '',
  'You **must** post a screenshot showing:',
  '1. **Game folder** — Right‑click the game folder → **Properties** (visible in screenshot)',
  '2. **WUB (Windows Update Blocker)** — Must show updates disabled/paused **and the red shield with X icon** (WUB active state)',
  '',
  'Upload your screenshot in this channel. The bot will automatically verify it (game folder Properties + WUB). Supports multiple languages.',
].join('\n');

export async function createTicketForGame(interaction, appId, options = {}) {
  const { requireTicketCategory = false } = options;

  if (!isValidAppId(appId)) return { ok: false, error: 'Invalid game ID.' };
  const game = getGameByAppId(appId);
  if (!game) return { ok: false, error: 'Game not found.' };
  if (!interaction.guildId || !interaction.guild) {
    return { ok: false, error: 'This must be used in a server.' };
  }
  if (requireTicketCategory && !config.ticketCategoryId) {
    return { ok: false, error: 'Ticket category not configured. Set TICKET_CATEGORY_ID for the panel.' };
  }

  const activators = getActivatorsForGame(appId);
  if (activators.length === 0) {
    return { ok: false, error: `**${game.name}** is out of stock. Try again later.` };
  }

  const requestId = createRequest(interaction.user.id, game.appId, game.name);

  const overwrites = [
    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
  ];
  if (config.activatorRoleId) {
    overwrites.push({
      id: config.activatorRoleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    });
  }

  let ticketChannel = null;
  if (config.ticketCategoryId) {
    ticketChannel = await interaction.guild.channels.create({
      name: `activation-${game.name.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 30)}-${requestId.slice(0, 8)}`,
      type: ChannelType.GuildText,
      parent: config.ticketCategoryId,
      permissionOverwrites: overwrites,
    });
  }
  setTicketChannel(requestId, ticketChannel?.id ?? interaction.channelId);

  const claimRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`claim_request:${requestId}`)
      .setLabel('I\'ll handle this')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('close_ticket')
      .setLabel('Close ticket')
      .setStyle(ButtonStyle.Secondary)
  );

  const activatorMentions = activators.map((a) => `<@${a.activator_id}>`).join(' ');

  const mainEmbed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🎮 Activation Request: ${game.name}`)
    .setDescription(
      [
        `**Requester:** <@${interaction.user.id}>`,
        '',
        `${activatorMentions}`,
        'First activator to press the button claims this request. Staff earn points per completion.',
      ].join('\n')
    )
    .addFields({
      name: '📸 Screenshot Required',
      value: SCREENSHOT_INSTRUCTIONS,
      inline: false,
    })
    .setFooter({ text: 'Post your screenshot in this channel, then an activator can claim.' })
    .setTimestamp();

  const msg = {
    content: null,
    embeds: [mainEmbed],
    components: [claimRow],
  };

  if (ticketChannel) {
    await ticketChannel.send(msg);
    return { ok: true, channel: ticketChannel };
  }
  return { ok: true, message: msg };
}
