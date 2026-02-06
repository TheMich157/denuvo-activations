import { MessageFlags } from 'discord.js';
import { failRequest, getPendingRequestForChannel } from '../services/requests.js';
import { isActivator } from '../utils/activator.js';

export async function handleButton(interaction) {
  if (!interaction.isButton() || interaction.customId !== 'invalid_token') return false;

  const req = getPendingRequestForChannel(interaction.channelId);
  if (!req) {
    await interaction.reply({ content: 'No active request in this channel.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const isIssuer = interaction.user.id === req.issuer_id;
  const activator = isActivator(interaction.member);
  if (!isIssuer && !activator) {
    await interaction.reply({ content: 'Only the assigned issuer or an activator can report invalid token.', flags: MessageFlags.Ephemeral });
    return true;
  }

  failRequest(req.id, 'failed');
  await interaction.reply({
    content: 'Token marked as invalid. The requester can open a new ticket to try again.',
  });
  return true;
}
