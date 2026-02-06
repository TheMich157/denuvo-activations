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
            'Automatic verification passed. Detected: game folder **Properties** and WUB (**Windows updates paused** or equivalent).'
          )
          .setFooter({ text: 'Ready for activator to claim' }),
      ],
    });
  } else {
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xfee75c)
          .setTitle('📸 Screenshot received')
          .setDescription(
            result.error
              ? 'Could not auto-verify (OCR failed). Activators: please verify the screenshot shows game folder **Properties** and WUB with **Windows updates paused** (or equivalent in your language) before claiming.'
              : 'Could not detect required elements. Please ensure the screenshot clearly shows:\n1. Game folder **Properties** (right‑click → Properties)\n2. **WUB** with "Windows updates paused" or equivalent visible. All languages supported.'
          )
          .setFooter({ text: result.error ? 'Manual verification required' : 'Auto-verify: missing required text' }),
      ],
    });
  }
}
