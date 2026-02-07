import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  AttachmentBuilder,
} from 'discord.js';
import { getRequestByChannel, markScreenshotVerified } from '../services/requests.js';
import { verifyScreenshot } from '../services/screenshotVerify/index.js';
import {
  mergeDetection,
  recordFailure,
  clearState,
} from '../services/screenshotVerify/state.js';
import { config } from '../config.js';
import { fetchManifest } from '../services/manifest.js';
import { checkRateLimit, getRemainingCooldown } from '../utils/rateLimit.js';
import { getGameByAppId, getGameDisplayName } from '../utils/games.js';

const IMAGE_EXT = /\.(png|jpg|jpeg|webp|gif)(\?.*)?$/i;
const FAIL_THRESHOLD = 5;
const MANIFEST_RATE_LIMIT = 3;         // max requests
const MANIFEST_RATE_WINDOW = 60_000;   // per 60 seconds

function buildManualVerifyRow(channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`manual_verify_screenshot:${channelId}`)
      .setLabel('Approve manually')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✋')
  );
}

async function handleManifestRequest(message) {
  if (!config.manifestChannelId || message.channelId !== config.manifestChannelId) return false;
  if (!config.ryuuApiKey) return false;

  const content = message.content.trim();
  // Accept plain numbers (Steam app IDs)
  const appIdMatch = content.match(/^\d+$/);
  if (!appIdMatch) {
    const helpEmbed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('📦 Manifest Request')
      .setDescription(
        'Send a valid **Steam App ID** (numbers only) to download the game manifest.\n\n' +
        '**Example:** `500` (Left 4 Dead)\n\n' +
        'You can find App IDs on [SteamDB](https://steamdb.info/) or the Steam store URL.'
      )
      .setTimestamp();
    await message.reply({ embeds: [helpEmbed] });
    return true;
  }

  // Rate limit: prevent spam
  if (!checkRateLimit(message.author.id, 'manifest', MANIFEST_RATE_LIMIT, MANIFEST_RATE_WINDOW)) {
    const remaining = getRemainingCooldown(message.author.id, 'manifest');
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle('⏳ Slow down')
          .setDescription(`You can request **${MANIFEST_RATE_LIMIT}** manifests per minute. Try again in **${remaining}s**.`)
          .setTimestamp(),
      ],
    });
    return true;
  }

  const appId = appIdMatch[0];

  // Resolve game name from list.json if available
  const knownGame = getGameByAppId(parseInt(appId, 10));
  const gameName = knownGame ? getGameDisplayName(knownGame) : null;
  const gameLabel = gameName ? `**${gameName}** (${appId})` : `App ID **${appId}**`;

  // Show loading reaction + pending embed
  await message.react('📦').catch(() => {});

  const pendingEmbed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📦 Fetching Manifest…')
    .setDescription(`Downloading manifest for ${gameLabel}. Please wait…`)
    .setFooter({ text: `Requested by ${message.author.displayName || message.author.username}` })
    .setTimestamp();
  const pendingMsg = await message.reply({ embeds: [pendingEmbed] });

  try {
    const result = await fetchManifest(appId);

    // Remove loading reaction, add success
    await message.reactions.cache.get('📦')?.users?.remove(message.client.user.id).catch(() => {});
    await message.react('✅').catch(() => {});

    if (result.type === 'file') {
      const sizeKb = (result.buffer.length / 1024).toFixed(1);
      const attachment = new AttachmentBuilder(result.buffer, { name: result.filename });
      const successEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ Manifest Ready')
        .setDescription(`Manifest for ${gameLabel} is ready.`)
        .addFields(
          { name: '📁 File', value: result.filename, inline: true },
          { name: '📏 Size', value: `${sizeKb} KB`, inline: true },
        )
        .setFooter({ text: `Requested by ${message.author.displayName || message.author.username}` })
        .setTimestamp();
      await pendingMsg.edit({ embeds: [successEmbed], files: [attachment] });
    } else {
      // JSON response — format and display
      const jsonStr = JSON.stringify(result.data, null, 2);
      if (jsonStr.length <= 1900) {
        const successEmbed = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle('✅ Manifest Ready')
          .setDescription(`Manifest data for ${gameLabel}:\n\`\`\`json\n${jsonStr}\n\`\`\``)
          .setFooter({ text: `Requested by ${message.author.displayName || message.author.username}` })
          .setTimestamp();
        await pendingMsg.edit({ embeds: [successEmbed] });
      } else {
        const attachment = new AttachmentBuilder(
          Buffer.from(jsonStr, 'utf-8'),
          { name: `manifest_${appId}.json` }
        );
        const successEmbed = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle('✅ Manifest Ready')
          .setDescription(`Manifest data for ${gameLabel} (attached as file — too large for embed).`)
          .setFooter({ text: `Requested by ${message.author.displayName || message.author.username}` })
          .setTimestamp();
        await pendingMsg.edit({ embeds: [successEmbed], files: [attachment] });
      }
    }
  } catch (err) {
    // Remove loading reaction, add failure
    await message.reactions.cache.get('📦')?.users?.remove(message.client.user.id).catch(() => {});
    await message.react('❌').catch(() => {});

    const errorEmbed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('❌ Manifest Failed')
      .setDescription(`Could not fetch manifest for ${gameLabel}.`)
      .addFields({ name: 'Error', value: err.message || 'Unknown error', inline: false })
      .setFooter({ text: 'Check the App ID and try again' })
      .setTimestamp();
    await pendingMsg.edit({ embeds: [errorEmbed] });
  }
  return true;
}

export async function handleMessage(message) {
  if (message.author.bot || !message.guild) return;

  // Handle manifest requests in the designated channel
  if (await handleManifestRequest(message)) return;

  const req = getRequestByChannel(message.channelId);
  if (!req || req.buyer_id !== message.author.id) return;

  const attachment = message.attachments.find((a) => IMAGE_EXT.test(a.url));
  if (!attachment) return;

  const result = await verifyScreenshot(attachment.url, req.game_name);
  if (result.gameMismatch) {
    const expected = req.game_name;
    const msg =
      'detectedGame' in result.gameMismatch
        ? `Your screenshot shows the game folder for **${result.gameMismatch.detectedGame}**, but this ticket is for **${expected}**. Please post a screenshot of the **${expected}** game folder (Properties and WUB).`
        : `We couldn't find **${expected}** in your screenshot. Please post a screenshot that clearly shows the **${expected}** game folder (right‑click → Properties) and WUB.`;
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('📸 Wrong game in screenshot')
      .setDescription(msg)
      .setFooter({ text: 'The folder name in your screenshot must match the game you requested.' })
      .setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }
  const merged = mergeDetection(message.channelId, {
    hasProperties: result.hasProperties,
    hasWub: result.hasWub,
  });

  const verified = merged.hasProperties && merged.hasWub;

  if (result.error) {
    const failCount = recordFailure(message.channelId, merged);
    const showManual = failCount >= FAIL_THRESHOLD;
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('📸 Screenshot received – verification failed')
      .setDescription(
        'Could not auto-verify this screenshot. ' +
          (showManual
            ? '**Activators:** You may approve manually using the button below.'
            : 'Activators: please verify the screenshot manually before claiming.')
      )
      .addFields(
        { name: 'Reason', value: result.error, inline: false },
        {
          name: 'Attempts',
          value: `${failCount}/${FAIL_THRESHOLD}`,
          inline: true,
        },
        {
          name: 'Provider',
          value: result.provider || '—',
          inline: true,
        }
      )
      .setTimestamp();
    const payload = { embeds: [embed] };
    if (showManual) payload.components = [buildManualVerifyRow(message.channelId)];
    await message.reply(payload);
    return;
  }

  if (verified) {
    markScreenshotVerified(req.id);
    clearState(message.channelId);
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅ Screenshot verified')
      .addFields(
        {
          name: 'Game folder Properties',
          value: '✓ Detected',
          inline: true,
        },
        {
          name: 'WUB (updates paused + red shield)',
          value: '✓ Detected',
          inline: true,
        },
        {
          name: 'Status',
          value: 'Ready for activator to claim.',
          inline: false,
        }
      )
      .setFooter({ text: result.provider ? `Verified via ${result.provider}` : 'Verification complete' })
      .setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }

  const failCount = recordFailure(message.channelId, merged);
  const showManual = failCount >= FAIL_THRESHOLD;

  const progress = (merged.hasProperties ? 1 : 0) + (merged.hasWub ? 1 : 0);
  const providerText = result.provider ? ` via ${result.provider}` : '';

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('📸 Screenshot received – partial')
    .setDescription(merged.isNewProgress
      ? 'Some elements were detected. Progress saved — you can post another screenshot to add the rest.'
      : 'Add the missing element(s) and post an updated screenshot.')
    .addFields(
      {
        name: 'Game folder Properties',
        value: merged.hasProperties ? '✓ Detected' : '○ Missing — right‑click folder → Properties',
        inline: true,
      },
      {
        name: 'WUB (updates paused + red shield/X)',
        value: merged.hasWub ? '✓ Detected' : '○ Missing — WUB with updates paused **and red shield with X icon**',
        inline: true,
      },
      {
        name: 'Progress',
        value: `${progress}/2 detected${providerText}`,
        inline: true,
      },
      {
        name: 'Attempts',
        value: `${failCount}/${FAIL_THRESHOLD}`,
        inline: true,
      }
    )
    .setTimestamp();

  const payload = { embeds: [embed] };
  if (showManual) payload.components = [buildManualVerifyRow(message.channelId)];
  await message.reply(payload);
}
