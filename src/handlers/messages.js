import { EmbedBuilder } from 'discord.js';
import { getRequestByChannel } from '../services/requests.js';

const IMAGE_EXT = /\.(png|jpg|jpeg|webp|gif)(\?.*)?$/i;

export async function handleMessage(message) {
  if (message.author.bot || !message.guild) return;
  const req = getRequestByChannel(message.channelId);
  if (!req || req.buyer_id !== message.author.id) return;

  const attachment = message.attachments.find((a) => IMAGE_EXT.test(a.url));
  if (!attachment) return;

  await message.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('📸 Screenshot received')
        .setDescription(
          'Activators: please verify the screenshot shows game folder Properties and WUB with "Windows updates paused" before claiming.'
        )
        .setFooter({ text: 'Manual verification required' }),
    ],
  });
}
