import { EmbedBuilder } from 'discord.js';
import { getRequestByChannel } from '../services/requests.js';
import { verifyScreenshot } from '../services/screenshotVerify.js';

const IMAGE_EXT = /\.(png|jpg|jpeg|webp|gif)(\?.*)?$/i;

export async function handleMessage(message) {
  if (message.author.bot || !message.guild) return;
  const req = getRequestByChannel(message.channelId);
  if (!req || req.buyer_id !== message.author.id) return;

  const attachment = message.attachments.find((a) => IMAGE_EXT.test(a.url));
  if (!attachment) return;

  const result = await verifyScreenshot(attachment.url);

  if (result.verified) {
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle('✅ Screenshot verified')
          .setDescription(
            [
              '**Progress: 2/2** ✓',
              '✓ Game folder **Properties**',
              '✓ WUB (updates paused + red shield/X icon)',
              '',
              'Ready for activator to claim.',
            ].join('\n')
          )
          .setFooter({ text: 'Verification complete' }),
      ],
    });
  } else if (result.error) {
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xfee75c)
          .setTitle('📸 Screenshot received')
          .setDescription(
            'Could not auto-verify (OCR failed). Activators: please verify manually before claiming.'
          )
          .setFooter({ text: 'Manual verification required' }),
      ],
    });
  } else {
    const parts = ['**Progress:**'];
    if (result.hasProperties) parts.push('✓ Game folder **Properties**');
    else parts.push('○ Game folder **Properties** (right‑click folder → Properties)');
    if (result.hasWub) parts.push('✓ WUB (updates paused + red shield/X)');
    else parts.push('○ WUB with updates paused/disabled **and red shield with X icon**');
    parts.push('');
    parts.push('Add the missing element(s) and post an updated screenshot.');

    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xfee75c)
          .setTitle('📸 Screenshot received – partial')
          .setDescription(parts.join('\n'))
          .setFooter({ text: `${(result.hasProperties ? 1 : 0) + (result.hasWub ? 1 : 0)}/2 elements detected` }),
      ],
    });
  }
}
