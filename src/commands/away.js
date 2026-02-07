import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';
import { setAway, isAway } from '../services/activatorStatus.js';

export const data = new SlashCommandBuilder()
  .setName('away')
  .setDescription('Toggle your away status (Activator only) — you won\'t be pinged while away')
  .setContexts(0);

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });
  if (!isActivator(interaction.member)) {
    return interaction.reply({ content: 'Only activators can use this command.', flags: MessageFlags.Ephemeral });
  }

  const currentlyAway = isAway(interaction.user.id);
  setAway(interaction.user.id, !currentlyAway);

  if (currentlyAway) {
    await interaction.reply({
      content: '✅ **You are now available.** You will be pinged for new activation requests.',
      flags: MessageFlags.Ephemeral,
    });
  } else {
    await interaction.reply({
      content: '🌙 **You are now away.** You won\'t be pinged for new requests until you run `/away` again.',
      flags: MessageFlags.Ephemeral,
    });
  }
}
