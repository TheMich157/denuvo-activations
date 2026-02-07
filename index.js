import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { REST, Routes } from 'discord.js';
import { Client, Events, GatewayIntentBits, ActivityType, PresenceUpdateStatus } from 'discord.js';
import { config, validateConfig } from './src/config.js';
import { initDb } from './src/db/index.js';
import { handleMessage } from './src/handlers/messages.js';
import { canUseCommand } from './src/utils/whitelist.js';
import { startTicketAutoClose } from './src/services/ticketAutoClose.js';
import { setClient as setActivationLogClient } from './src/services/activationLog.js';
import { startStockRestock } from './src/services/stockRestock.js';
import { startDailyDigest } from './src/services/dailyDigest.js';
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
  startBackupService();
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
    const { allowed, reason } = canUseCommand(
      interaction.user.id,
      interaction.commandName,
      interaction.member
    );
    if (!allowed) {
      return interaction.reply({ content: reason || 'Command not allowed.', flags: MessageFlags.Ephemeral });
    }
    return cmd.execute(interaction);
  }
  return handle(interaction);
});

client.on(Events.MessageCreate, handleMessage);

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.user.bot) return;
  // Auto-assign unverified role on join
  if (config.unverifiedRoleId) {
    try {
      await member.roles.add(config.unverifiedRoleId);
      console.log(`[Verify] Assigned unverified role to ${member.user.tag}`);
    } catch (err) {
      console.error(`[Verify] Failed to assign unverified role to ${member.user.tag}:`, err.message);
    }
  }
  // Send a welcome hint to the verify channel
  if (config.verifyChannelId) {
    try {
      const channel = await member.client.channels.fetch(config.verifyChannelId).catch(() => null);
      if (channel) {
        const embed = new (await import('discord.js')).EmbedBuilder()
          .setColor(0x5865F2)
          .setDescription(`👋 Welcome <@${member.id}>! Ping me here to start your verification quiz and unlock the server.`)
          .setFooter({ text: 'Type @DenuBrew or mention the bot to begin' });
        const msg = await channel.send({ content: `<@${member.id}>`, embeds: [embed] });
        setTimeout(() => msg.delete().catch(() => {}), 60000);
      }
    } catch {}
  }
});

client.login(config.token).catch((err) => {
  console.error('Login failed:', err);
  process.exit(1);
});
