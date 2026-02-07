import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { db, scheduleSave } from '../db/index.js';
import { requireGuild } from '../utils/guild.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getSchedule(activatorId) {
  return db.prepare('SELECT * FROM activator_schedules WHERE activator_id = ?').get(activatorId);
}

function setSchedule(activatorId, timezone, start, end, days) {
  db.prepare(`
    INSERT INTO activator_schedules (activator_id, timezone, available_start, available_end, days)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(activator_id) DO UPDATE SET timezone = ?, available_start = ?, available_end = ?, days = ?
  `).run(activatorId, timezone, start, end, days, timezone, start, end, days);
  scheduleSave();
}

/**
 * Check if an activator is currently available based on their schedule.
 */
export function isScheduleAvailable(activatorId) {
  const sched = getSchedule(activatorId);
  if (!sched) return true; // No schedule = always available
  const now = new Date();
  // Simple timezone offset (supports UTC+N / UTC-N format or IANA-ish)
  let hour = now.getUTCHours();
  const tzMatch = sched.timezone.match(/UTC([+-]\d+)/i);
  if (tzMatch) hour = (hour + parseInt(tzMatch[1]) + 24) % 24;

  const day = now.getUTCDay();
  const availableDays = sched.days.split(',').map(Number);
  if (!availableDays.includes(day)) return false;

  if (sched.available_start <= sched.available_end) {
    return hour >= sched.available_start && hour < sched.available_end;
  }
  // Wraps around midnight
  return hour >= sched.available_start || hour < sched.available_end;
}

export const data = new SlashCommandBuilder()
  .setName('schedule')
  .setDescription('Set your availability schedule (Activator)')
  .setContexts(0)
  .addSubcommand((sub) =>
    sub.setName('set')
      .setDescription('Set your availability hours')
      .addStringOption((o) => o.setName('timezone').setDescription('e.g. UTC+2, UTC-5').setRequired(true))
      .addIntegerOption((o) => o.setName('start').setDescription('Start hour (0-23)').setRequired(true))
      .addIntegerOption((o) => o.setName('end').setDescription('End hour (0-23)').setRequired(true))
      .addStringOption((o) => o.setName('days').setDescription('Days: 0=Sun,1=Mon,...6=Sat comma-separated (default: all)').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub.setName('view')
      .setDescription('View your current schedule')
  )
  .addSubcommand((sub) =>
    sub.setName('clear')
      .setDescription('Clear your schedule (always available)')
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const sub = interaction.options.getSubcommand();

  if (sub === 'set') {
    const tz = interaction.options.getString('timezone');
    const start = interaction.options.getInteger('start');
    const end = interaction.options.getInteger('end');
    const daysStr = interaction.options.getString('days') || '0,1,2,3,4,5,6';

    if (start < 0 || start > 23 || end < 0 || end > 23) {
      return interaction.reply({ content: 'Hours must be 0–23.', flags: MessageFlags.Ephemeral });
    }

    setSchedule(interaction.user.id, tz, start, end, daysStr);
    const dayNames = daysStr.split(',').map((d) => DAYS[parseInt(d)] || d).join(', ');
    return interaction.reply({
      content: `✅ Schedule set: **${start}:00–${end}:00** (${tz}) on **${dayNames}**`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'view') {
    const sched = getSchedule(interaction.user.id);
    if (!sched) return interaction.reply({ content: 'No schedule set — you\'re marked as always available.', flags: MessageFlags.Ephemeral });
    const dayNames = sched.days.split(',').map((d) => DAYS[parseInt(d)] || d).join(', ');
    const available = isScheduleAvailable(interaction.user.id);
    const embed = new EmbedBuilder()
      .setColor(available ? 0x57f287 : 0xed4245)
      .setTitle('🕐 Your Schedule')
      .addFields(
        { name: 'Hours', value: `${sched.available_start}:00 – ${sched.available_end}:00`, inline: true },
        { name: 'Timezone', value: sched.timezone, inline: true },
        { name: 'Days', value: dayNames, inline: false },
        { name: 'Currently', value: available ? '🟢 Available' : '🔴 Outside hours', inline: true },
      )
      .setTimestamp();
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'clear') {
    db.prepare('DELETE FROM activator_schedules WHERE activator_id = ?').run(interaction.user.id);
    scheduleSave();
    return interaction.reply({ content: '✅ Schedule cleared — you\'re now always available.', flags: MessageFlags.Ephemeral });
  }
}
