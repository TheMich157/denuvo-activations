import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config, validateConfig } from './src/config.js';
import { initDb } from './src/db/index.js';
import { handle } from './src/handlers/interactions.js';
import { handleMessage } from './src/handlers/messages.js';

validateConfig();
await initDb();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, handle);
client.on(Events.MessageCreate, handleMessage);

client.login(config.token).catch((err) => {
  console.error('Login failed:', err);
  process.exit(1);
});
