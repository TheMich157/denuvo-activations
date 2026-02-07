import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { REST, Routes } from 'discord.js';
import { Client, Events, GatewayIntentBits, ActivityType, PresenceUpdateStatus } from 'discord.js';
import { config, validateConfig } from './src/config.js';
import { initDb } from './src/db/index.js';
import { handleMessage } from './src/handlers/messages.js';
import { canUseCommand } from './src/utils/whitelist.js';
import { startTicketAutoClose, stopTicketAutoClose } from './src/services/ticketAutoClose.js';
import { setClient as setActivationLogClient } from './src/services/activationLog.js';
import { startStockRestock, stopStockRestock } from './src/services/stockRestock.js';
import { startDailyDigest, stopDailyDigest } from './src/services/dailyDigest.js';
import { syncPanelMessage, setPanelClient } from './src/services/panel.js';
import { buildPanelMessagePayload } from './src/commands/ticketpanel.js';
import { startBackupService } from './src/services/backup.js';
import { startLeaderboardScheduler } from './src/services/leaderboardScheduler.js';
import { startGiveawayScheduler } from './src/services/giveawayScheduler.js';
import { MessageFlags } from 'discord.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { handle } = await import(new URL('./src/handlers/interactions.js', import.meta.url).href);

validateConfig();
await initDb();

const commands = new Map();
const commandFiles = readdirSync(join(__dirname, 'src/commands'))
  .filter((f) => f.endsWith('.js') && f !== 'panelHandler.js' && f !== 'call_mod.js');

for (const file of commandFiles) {
  const mod = await import(`./src/commands/${file}`);
  if (mod.data?.name) commands.set(mod.data.name, mod);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  presence: {
    status: PresenceUpdateStatus.Idle,
    activities: [{
      name: 'Getting you your denuvo tokens',
      type: ActivityType.Listening,
    }],
  },
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  const rest = new REST().setToken(config.token);
  const body = [...commands.values()].map((m) => m.data.toJSON());
  try {
    if (config.guildId) {
      await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
    } else {
      await rest.put(Routes.applicationCommands(config.clientId), { body });
    }
    console.log(`Registered ${body.length} slash commands`);
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
  startTicketAutoClose(client);
  setActivationLogClient(client);
  startStockRestock(client);
  startDailyDigest(client);
  startBackupService(client);
  startLeaderboardScheduler(client);
  startGiveawayScheduler(client);
  setPanelClient(client, buildPanelMessagePayload);
  syncPanelMessage(client, buildPanelMessagePayload()).catch((err) =>
    console.error('[Panel] Startup sync failed:', err?.message)
  );
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    const cmd = commands.get(interaction.commandName);
    if (cmd?.autocomplete) return cmd.autocomplete(interaction);
  }
  if (interaction.isChatInputCommand()) {
    const cmd = commands.get(interaction.commandName);
    if (!cmd?.execute) return;
    // Allow everyone to use /skiptoken balance and /skiptoken buy, even though the main command is whitelisted
    if (
      interaction.commandName === 'skiptoken' &&
      ['balance', 'buy'].includes(interaction.options?.getSubcommand(false))
    ) {
      try {
        return await cmd.execute(interaction);
      } catch (err) {
        console.error(`[Command] /${interaction.commandName} ${interaction.options?.getSubcommand(false)} error:`, err);
        const content = 'Something went wrong running this command. Please try again.';
        if (interaction.deferred || interaction.replied) {
          return interaction.editReply({ content }).catch(() => {});
        }
        return interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }

    const { allowed, reason } = canUseCommand(
      interaction.user.id,
      interaction.commandName,
      interaction.member
    );
    if (!allowed) {
      return interaction.reply({ content: reason || 'Command not allowed.', flags: MessageFlags.Ephemeral });
    }
    try {
      return await cmd.execute(interaction);
    } catch (err) {
      console.error(`[Command] /${interaction.commandName} error:`, err);
      const content = 'Something went wrong running this command. Please try again.';
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ content }).catch(() => {});
      }
      return interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
  return handle(interaction);
});

client.on(Events.MessageCreate, handleMessage);

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.user?.bot) return;
  const { EmbedBuilder } = await import('discord.js');

  // Welcome message: prefer dedicated welcome channel, fallback to verify channel
  const welcomeChId = config.welcomeChannelId || config.verifyChannelId;

  // Fire both role assignment and welcome message concurrently for instant delivery
  const rolePromise = (async () => {
    if (config.unverifiedRoleId) {
      try {
        await member.roles.add(config.unverifiedRoleId);
        console.log(`[Verify] Assigned unverified role to ${member.user.tag}`);
      } catch (err) {
        console.error(`[Verify] Failed to assign unverified role to ${member.user.tag}:`, err.message);
      }
    }
  })();

  const welcomePromise = (async () => {
    if (!welcomeChId) return;
    try {
      const channel = await member.client.channels.fetch(welcomeChId).catch(() => null);
      if (!channel) return;

      const memberCount = member.guild.memberCount;
      const verifyChannelMention = config.verifyChannelId ? `<#${config.verifyChannelId}>` : null;
      const manifestChannelMention = '<#1469623406898184295>';
      const verifyInstruction = verifyChannelMention
        ? `Head to ${verifyChannelMention} and ping the bot to start the verification quiz.`
        : 'Complete the verification quiz in the verification channel to unlock the server.';

      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL({ size: 128 }) })
        .setTitle('Welcome to DenuBrew!')
        .setDescription(
          [
            `Hey <@${member.id}>, welcome! You're member **#${memberCount}**.`,
            '',
            `**🔓 Verify to unlock:** ${verifyInstruction}`,
            '',
            'We provide **free Denuvo activation tokens** for your Steam games. Once verified, use the activation panel to request a game.',
            '',
            `**📦 Manifest files:** We also offer manifest files through ${manifestChannelMention} — just send a Steam App ID!`,
          ].join('\n')
        )
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
        .setFooter({ text: `Member #${memberCount} • DenuBrew` })
        .setTimestamp();

      await channel.send({ content: `<@${member.id}>`, embeds: [embed] });
    } catch (err) {
      console.error('[Welcome] Failed to send join message:', err?.message);
    }
  })();

  await Promise.all([rolePromise, welcomePromise]);
});

client.on(Events.GuildMemberRemove, async (member) => {
  if (member.user?.bot) return;
  const { EmbedBuilder } = await import('discord.js');

  const welcomeChId = config.welcomeChannelId || config.verifyChannelId;
  if (!welcomeChId) return;

  // Fetch channel immediately — don't block on user resolution
  const channel = await member.client.channels.fetch(welcomeChId).catch(() => null);
  if (!channel) return;

  // Handle partial member (user might be missing if not cached)
  let user = member.user;
  if (!user) {
    try {
      user = await member.client.users.fetch(member.id).catch(() => null);
    } catch {}
  }

  try {
    if (user) {
      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL({ size: 128 }) })
        .setDescription(`**${user.tag}** left the server. We now have **${member.guild.memberCount}** members.`)
        .setFooter({ text: 'DenuBrew' })
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    } else {
      await channel.send({ content: `A member left the server. We now have **${member.guild.memberCount}** members.` });
    }
  } catch (err) {
    console.error('[Leave] Failed to send leave message:', err?.message);
  }
});

// Global error handlers to prevent crashes
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
});
client.on('error', (err) => {
  console.error('[Discord] Client error:', err);
});

// Graceful shutdown — stop all schedulers and destroy client
function gracefulShutdown(signal) {
  console.log(`[Shutdown] Received ${signal}, cleaning up...`);
  stopTicketAutoClose();
  stopStockRestock();
  stopDailyDigest();
  client.destroy();
  console.log('[Shutdown] Cleanup complete.');
}
process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });

client.login(config.token).catch((err) => {
  console.error('Login failed:', err);
  process.exit(1);
});
