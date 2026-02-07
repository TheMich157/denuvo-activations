import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { db } from '../db/index.js';

export const data = new SlashCommandBuilder()
  .setName('history')
  .setDescription('View your activation request history')
  .addStringOption((o) =>
    o.setName('status')
      .setDescription('Filter by status')
      .addChoices(
        { name: 'All', value: 'all' },
        { name: 'Completed', value: 'completed' },
        { name: 'Pending', value: 'pending' },
        { name: 'Failed', value: 'failed' },
        { name: 'Cancelled', value: 'cancelled' }
      )
  )
  .addIntegerOption((o) =>
    o.setName('page').setDescription('Page number (default 1)').setMinValue(1)
  );

const PAGE_SIZE = 10;

export async function execute(interaction) {
  const userId = interaction.user.id;
  const statusFilter = interaction.options.getString('status') || 'all';
  const page = interaction.options.getInteger('page') || 1;
  const offset = (page - 1) * PAGE_SIZE;

  let countSql = 'SELECT COUNT(*) AS n FROM requests WHERE buyer_id = ?';
  let querySql = 'SELECT id, game_name, game_app_id, status, created_at, completed_at FROM requests WHERE buyer_id = ?';
  const params = [userId];

  if (statusFilter !== 'all') {
    countSql += ' AND status = ?';
    querySql += ' AND status = ?';
    params.push(statusFilter);
  }

  querySql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

  const totalRow = db.prepare(countSql).get(...params);
  const total = totalRow?.n ?? 0;

  if (total === 0) {
    return interaction.reply({
      content: statusFilter === 'all'
        ? 'You have no activation requests yet.'
        : `No requests with status **${statusFilter}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const rows = db.prepare(querySql).all(...params, PAGE_SIZE, offset);
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const statusEmoji = {
    pending: '🟡',
    in_progress: '🔵',
    completed: '✅',
    failed: '❌',
    cancelled: '🚫',
  };

  const lines = rows.map((r) => {
    const emoji = statusEmoji[r.status] ?? '⚪';
    const ref = `#${r.id.slice(0, 8).toUpperCase()}`;
    const date = r.completed_at || r.created_at;
    const timestamp = date ? `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>` : '';
    return `${emoji} **${r.game_name}** — ${r.status} ${timestamp}\n\u2003\u2003\`${ref}\``;
  });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📜 Request History')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Page ${page}/${totalPages} • ${total} total request${total !== 1 ? 's' : ''}${statusFilter !== 'all' ? ` (${statusFilter})` : ''}` })
    .setTimestamp();

  if (totalPages > 1 && page < totalPages) {
    embed.setFooter({ text: `Page ${page}/${totalPages} • ${total} total • Use /history page:${page + 1} for more` });
  }

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
