import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { REST, Routes } from 'discord.js';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config, validateConfig } from './src/config.js';
import { initDb } from './src/db/index.js';
import { handleMessage } from './src/handlers/messages.js';
import { canUseCommand } from './src/utils/whitelist.js';
import { startTicketAutoClose } from './src/services/ticketAutoClose.js';
import { syncPanelMessage } from './src/services/panel.js';
import { buildPanelMessagePayload } from './src/commands/ticketpanel.js';
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
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
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

client.login(config.token).catch((err) => {
  console.error('Login failed:', err);
  process.exit(1);
});
