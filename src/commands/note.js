import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { addNote, getNotes, removeNote } from '../services/notes.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('note')
  .setDescription('Manage private staff notes on users')
  .setContexts(0)
  .addSubcommand((sub) =>
    sub.setName('add')
      .setDescription('Add a note to a user')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
      .addStringOption((o) => o.setName('text').setDescription('Note text').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('list')
      .setDescription('View notes for a user')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('remove')
      .setDescription('Remove a note by ID')
      .addIntegerOption((o) => o.setName('id').setDescription('Note ID').setRequired(true))
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const user = interaction.options.getUser('user');
    const text = interaction.options.getString('text');
    const noteId = addNote(user.id, text, interaction.user.id);
    return interaction.reply({
      content: `📝 Note **#${noteId}** added to <@${user.id}>: ${text.slice(0, 100)}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'list') {
    const user = interaction.options.getUser('user');
    const notes = getNotes(user.id);
    if (notes.length === 0) return interaction.reply({ content: `No notes for <@${user.id}>.`, flags: MessageFlags.Ephemeral });

    const lines = notes.map((n) => {
      const date = new Date(n.created_at + 'Z');
      return `**#${n.id}** — ${n.note}\n> By <@${n.added_by}> • <t:${Math.floor(date.getTime() / 1000)}:R>`;
    });
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle(`📝 Notes: ${user.displayName}`)
      .setDescription(lines.join('\n\n'))
      .setFooter({ text: `${notes.length} note${notes.length !== 1 ? 's' : ''}` })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'remove') {
    const id = interaction.options.getInteger('id');
    const removed = removeNote(id);
    if (!removed) return interaction.reply({ content: `Note #${id} not found.`, flags: MessageFlags.Ephemeral });
    return interaction.reply({ content: `✅ Note **#${id}** removed.`, flags: MessageFlags.Ephemeral });
  }
}
