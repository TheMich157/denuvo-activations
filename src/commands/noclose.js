import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getRequestByChannel, setNoAutoClose } from '../services/requests.js';
import { isWhitelisted } from '../utils/whitelist.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('noclose')
  .setDescription('Prevent this ticket from being auto-closed due to inactivity')
  .setContexts(0);

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const req = getRequestByChannel(interaction.channelId);
  if (!req) {
    return interaction.reply({ content: 'This command can only be used inside a ticket channel.', flags: MessageFlags.Ephemeral });
  }

  const userId = interaction.user.id;
  const isStaff = isWhitelisted(userId);
  const isAssigned = req.issuer_id === userId;

  // Whitelisted staff can use on any ticket, activators only on their own
  if (!isStaff && !isAssigned) {
    if (!isActivator(interaction.member)) {
      return interaction.reply({ content: 'Only the assigned activator or staff can use this command.', flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({ content: 'You can only use this on tickets assigned to you.', flags: MessageFlags.Ephemeral });
  }

  // Toggle: if already set, unset it
  const currentlyProtected = req.no_auto_close === 1;
  setNoAutoClose(req.id, !currentlyProtected);

  if (currentlyProtected) {
    return interaction.reply({
      content: '🔓 Auto-close protection **removed**. This ticket will now auto-close after inactivity.',
    });
  } else {
    return interaction.reply({
      content: '🔒 Auto-close protection **enabled**. This ticket will **not** be auto-closed due to inactivity.',
    });
  }
}
