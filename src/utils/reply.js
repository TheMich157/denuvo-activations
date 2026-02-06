import { MessageFlags } from 'discord.js';

/** Use with interaction.reply/followUp instead of deprecated ephemeral: true */
export const ephemeralReply = { flags: MessageFlags.Ephemeral };
