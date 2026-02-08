import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getViewableCredentials, getAllAutomatedGames } from '../services/activators.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('credentials')
  .setDescription('[WL] View stored Steam credentials for automated games')
  .setContexts(0)
  .addSubcommand((sub) =>
    sub.setName('list')
      .setDescription('List all automated games with stored credentials')
  )
  .addSubcommand((sub) =>
    sub.setName('view')
      .setDescription('View credentials for a specific game (consent required)')
      .addIntegerOption((o) =>
        o.setName('appid').setDescription('Game App ID').setRequired(true)
      )
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const sub = interaction.options.getSubcommand();

  if (sub === 'list') return handleList(interaction);
  if (sub === 'view') return handleView(interaction);
}

async function handleList(interaction) {
  const rows = getAllAutomatedGames();

  if (rows.length === 0) {
    return interaction.reply({
      content: 'No automated games found in the database.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Group by game
  const games = new Map();
  for (const row of rows) {
    if (!games.has(row.game_app_id)) {
      games.set(row.game_app_id, { name: row.game_name, accounts: [] });
    }
    games.get(row.game_app_id).accounts.push(row);
  }

  const lines = [];
  for (const [appId, game] of games) {
    const accountParts = game.accounts.map((a) => {
      const consent = a.creds_viewable ? '🔓' : '🔒';
      return `${consent} \`${a.steam_username}\` (<@${a.activator_id}>)`;
    });
    lines.push(`**${game.name}** (\`${appId}\`)\n${accountParts.join('\n')}`);
  }

  const description = lines.join('\n\n');
  // Split into multiple embeds if too long
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if ((current + '\n\n' + line).length > 4000) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n\n' + line : line;
    }
  }
  if (current) chunks.push(current);

  const embeds = chunks.map((chunk, i) =>
    new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(i === 0 ? '🔐 Automated Games — Stored Credentials' : '🔐 Continued…')
      .setDescription(chunk)
      .setFooter(i === chunks.length - 1
        ? { text: `${games.size} game${games.size !== 1 ? 's' : ''} • ${rows.length} account${rows.length !== 1 ? 's' : ''} • 🔓 = consent given, 🔒 = no consent\nUse /credentials view appid:<id> to reveal credentials` }
        : undefined
      )
      .setTimestamp()
  );

  return interaction.reply({ embeds: embeds.slice(0, 10), flags: MessageFlags.Ephemeral });
}

async function handleView(interaction) {
  const appId = interaction.options.getInteger('appid');
  const creds = getViewableCredentials(appId);

  if (!creds) {
    return interaction.reply({
      content: `No viewable credentials found for App ID **${appId}**.\nEither no automated account exists for this game, or the activator did **not** consent to credential viewing.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('🔐 Stored Credentials')
    .setDescription(`**Game:** ${creds.gameName} (\`${appId}\`)\n**Activator:** <@${creds.activatorId}>`)
    .addFields(
      { name: '👤 Username', value: `\`${creds.username}\``, inline: true },
      { name: '🔑 Password', value: `||${creds.password}||`, inline: true }
    )
    .setFooter({ text: '⚠️ Activator consented to credential viewing • Handle with care • Do not share' })
    .setTimestamp();

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
