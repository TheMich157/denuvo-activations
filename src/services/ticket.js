import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    PermissionFlagsBits,
    EmbedBuilder,
  } from 'discord.js';
  import { createRequest, setTicketChannel, checkCooldown, assignIssuer } from './requests.js';
  import { getActivatorsForGame, getBestActivator, getCredentials } from './activators.js';
  import { getBalance } from './points.js';
  import { getGameByAppId, getCooldownHours, getGameDisplayName } from '../utils/games.js';
  import { config } from '../config.js';
  import { isValidAppId } from '../utils/validate.js';
  import { isActivator } from '../utils/activator.js';
  import { isBlacklisted } from './blacklist.js';
  import { joinWaitlist, isOnWaitlist } from './waitlist.js';
  import { isWhitelisted } from '../utils/whitelist.js';
  import { isAway } from './activatorStatus.js';
  import { notifyActivators } from './statusNotify.js';
  import { getUserTierInfo, getAdjustedCooldown, TIERS } from './tiers.js';
  import { getTokens, useToken } from './skipTokens.js';
  import { db } from '../db/index.js';
  
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

    // Blacklist check — silently block
    if (isBlacklisted(interaction.user.id)) {
      return { ok: false, error: 'You are not able to make requests. Contact an admin if you believe this is a mistake.' };
    }
  
    const activators = getActivatorsForGame(appId);
    if (activators.length === 0) {
      // Offer waitlist
      if (!isOnWaitlist(interaction.user.id, appId)) {
        joinWaitlist(interaction.user.id, appId);
        return { ok: false, error: `**${getGameDisplayName(game)}** is out of stock. You've been added to the **waitlist** — you'll get a DM when it's back in stock.` };
      }
      return { ok: false, error: `**${getGameDisplayName(game)}** is out of stock. You're already on the waitlist — we'll DM you when it's available.` };
    }
  
    const cooldownUntil = isActivator(interaction.member) ? null : checkCooldown(interaction.user.id, game.appId);
    const tierInfo = getUserTierInfo(interaction.user.id);
    let usedSkipToken = false;
    if (cooldownUntil) {
      // Check for skip token first
      const hasSkipToken = getTokens(interaction.user.id) > 0;
      if (hasSkipToken) {
        useToken(interaction.user.id);
        usedSkipToken = true;
        // Skip the cooldown entirely
      } else if (tierInfo.tier !== 'none') {
        // Tier members get reduced cooldown
        const baseCd = getCooldownHours(game.appId);
        const adjustedCd = getAdjustedCooldown(baseCd, interaction.user.id);
        const adjustedEnd = Date.now() - ((baseCd - adjustedCd) * 3600000);
        if (cooldownUntil > adjustedEnd) {
          const mins = Math.ceil((cooldownUntil - (baseCd - adjustedCd) * 3600000 - Date.now()) / 60000);
          if (mins > 0) {
            return {
              ok: false,
              error: `You can request **${getGameDisplayName(game)}** again in **${mins} minutes** (cooldown: ${adjustedCd}h — ${TIERS[tierInfo.tier].emoji} tier benefit).`,
            };
          }
        }
        // If adjusted cooldown has passed, allow through
      } else {
        const mins = Math.ceil((cooldownUntil - Date.now()) / 60000);
        const hoursLabel = getCooldownHours(game.appId) === 48 ? '48 hours (high demand)' : '24 hours';
        const tokenHint = `\n> 💡 Buy a **skip token** with \`/skiptoken buy\` to bypass cooldowns!`;
        return {
          ok: false,
          error: `You can request **${getGameDisplayName(game)}** again in **${mins} minutes** (cooldown: ${hoursLabel}).${tokenHint}`,
        };
      }
    }
  
    // Queue priority: VIP users (whitelisted + high points) OR tier members get a priority tag
    const buyerPoints = getBalance(interaction.user.id);
    const isVip = (isWhitelisted(interaction.user.id) && buyerPoints >= 100) || tierInfo.tier !== 'none';

    const requestId = createRequest(interaction.user.id, game.appId, game.name);

    // Calculate queue position
    const queuePosition = db.prepare(`
      SELECT COUNT(*) AS n FROM requests WHERE status IN ('pending', 'in_progress') AND created_at <= (
        SELECT created_at FROM requests WHERE id = ?
      )
    `).get(requestId)?.n ?? 1;

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
  
  const availableActivators = activators.filter((a) => !isAway(a.activator_id));
  const activatorMentions = (availableActivators.length > 0 ? availableActivators : activators)
    .map((a) => `<@${a.activator_id}>`).join(' ');
  const ticketRef = `#${requestId.slice(0, 8).toUpperCase()}`;

  // Try auto-assign best activator
  const best = getBestActivator(game.appId);
  let autoAssigned = false;
  if (best) {
    const result = assignIssuer(requestId, best.activator_id);
    if (result.ok) autoAssigned = true;
  }

  let mainEmbed;
  let components;

  if (autoAssigned) {
    const hasAutomated = !!getCredentials(best.activator_id, game.appId);
    mainEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle(`🎮 Activation Request: ${getGameDisplayName(game)}`)
      .setDescription(
        [
          `**Requester:** <@${interaction.user.id}>`,
          `**Auto-assigned to:** <@${best.activator_id}>`,
          '',
          hasAutomated
            ? '**Automatic:** Use **Get code automatically** (enter 2FA when asked). **Manual:** Use **Done** to paste the code. Press **Help** if needed.'
            : 'Use **Done** to enter the auth code from drm.steam.run. Press **Help** if needed.',
        ].join('\n')
      )
      .addFields(
        { name: '📋 Status', value: 'Auto-assigned — awaiting screenshot', inline: true },
        {
          name: '📸 Required — post a screenshot showing both (within 5 minutes):',
          value: `Upload your screenshot in this channel. The bot will verify automatically. **Ticket closes if not verified in 5 minutes** (${getCooldownHours(game.appId)}h cooldown applies).`,
          inline: false,
        },
        { name: '1. Game folder Properties', value: 'Right‑click the game folder → **Properties** (dialog visible in screenshot)', inline: false },
        { name: '2. WUB (Windows Update Blocker)', value: 'Updates disabled/paused **and the red shield with X icon**', inline: false }
      )
      .setFooter({ text: `Ticket ${ticketRef} • Post your screenshot, then activator can proceed` })
      .setTimestamp();

    const actionComponents = [
      new ButtonBuilder().setCustomId('done_request').setLabel('Done – enter auth code').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('call_activator').setLabel('Help').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('close_ticket').setLabel('Close ticket').setStyle(ButtonStyle.Secondary),
    ];
    if (hasAutomated) {
      actionComponents.unshift(
        new ButtonBuilder().setCustomId(`auto_code:${requestId}`).setLabel('Get code automatically').setStyle(ButtonStyle.Primary).setEmoji('⚡')
      );
    }
    components = [new ActionRowBuilder().addComponents(actionComponents)];
  } else {
    const tierBadge = tierInfo.tier !== 'none' ? ` ${TIERS[tierInfo.tier].emoji} **${TIERS[tierInfo.tier].label}**` : '';
    const vipTag = isVip ? (tierBadge || ' ⭐ **VIP**') : '';
    mainEmbed = new EmbedBuilder()
      .setColor(isVip ? (TIERS[tierInfo.tier]?.color || 0xf1c40f) : 0x5865f2)
      .setTitle(`🎮 Activation Request: ${getGameDisplayName(game)}`)
      .setDescription(
        [
          `**Requester:** <@${interaction.user.id}>${vipTag}`,
          '',
          `${activatorMentions}`,
          'First activator to press the button claims this request. Staff earn points per completion.',
        ].join('\n')
      )
      .addFields(
        { name: '📋 Status', value: 'Waiting for screenshot', inline: true },
        {
          name: '📸 Required — post a screenshot showing both (within 5 minutes):',
          value: `Upload your screenshot in this channel. The bot will verify automatically. **Ticket closes if not verified in 5 minutes** (${getCooldownHours(game.appId)}h cooldown applies).`,
          inline: false,
        },
        { name: '1. Game folder Properties', value: 'Right‑click the game folder → **Properties** (dialog visible in screenshot)', inline: false },
        { name: '2. WUB (Windows Update Blocker)', value: 'Updates disabled/paused **and the red shield with X icon**', inline: false }
      )
      .setFooter({ text: `Ticket ${ticketRef} • Post your screenshot, then an activator can claim` })
      .setTimestamp();
    components = [claimRow];
  }

    const msg = {
      content: null,
      embeds: [mainEmbed],
      components,
    };
  
    // Build extra info line for skip token / queue
    const extraLines = [];
    if (usedSkipToken) extraLines.push('⚡ **Skip token used** — cooldown bypassed!');
    if (queuePosition > 1) extraLines.push(`📊 **Queue position:** #${queuePosition}`);

    if (ticketChannel) {
      await ticketChannel.send(msg);
      if (extraLines.length > 0) {
        await ticketChannel.send({ content: extraLines.join('\n') }).catch(() => {});
      }
      // DM activators who have this game (not away)
      notifyActivators(interaction.client, {
        gameName: getGameDisplayName(game),
        gameAppId: game.appId,
        buyerId: interaction.user.id,
        ticketChannelId: ticketChannel.id,
      }, availableActivators).catch(() => {});
      return { ok: true, channel: ticketChannel, queuePosition, usedSkipToken };
    }
    return { ok: true, message: msg, queuePosition, usedSkipToken };
  }
  