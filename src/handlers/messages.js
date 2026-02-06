import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { getRequestByChannel, markScreenshotVerified } from '../services/requests.js';
import { verifyScreenshot } from '../services/screenshotVerify/index.js';
import {
  mergeDetection,
  recordFailure,
  clearState,
} from '../services/screenshotVerify/state.js';

const IMAGE_EXT = /\.(png|jpg|jpeg|webp|gif)(\?.*)?$/i;
const FAIL_THRESHOLD = 5;

function buildManualVerifyRow(channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`manual_verify_screenshot:${channelId}`)
      .setLabel('Approve manually')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✋')
  );
}

export async function handleMessage(message) {
  if (message.author.bot || !message.guild) return;
  const req = getRequestByChannel(message.channelId);
  if (!req || req.buyer_id !== message.author.id) return;

  const attachment = message.attachments.find((a) => IMAGE_EXT.test(a.url));
  if (!attachment) return;

  const result = await verifyScreenshot(attachment.url);

  // Merge with any saved partial progress
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

  // Partial: save progress and increment fail count
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
