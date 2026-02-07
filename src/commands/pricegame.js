import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { searchGames, getGameByAppId, loadGames, getGameDisplayName } from '../utils/games.js';

const STEAM_APPDETAILS = 'https://store.steampowered.com/api/appdetails';
const STEAM_STORE_APP = 'https://store.steampowered.com/app';
const CHEAPSHARK_GAMES = 'https://www.cheapshark.com/api/1.0/games';
const CHEAPSHARK_REDIRECT = 'https://www.cheapshark.com/redirect';
const CONCURRENCY = 5;
const DELAY_BETWEEN_BATCHES_MS = 300;
const FIELDS_PER_EMBED = 25;
const MAX_EMBEDS = 10;

function encodeQuery(s) {
  return encodeURIComponent((s || '').trim());
}

export const data = new SlashCommandBuilder()
  .setName('pricegame')
  .setDescription('Look up Steam or reseller prices for games from the list (whitelisted only)')
  .setDMPermission(false)
  .addStringOption((o) =>
    o
      .setName('game')
      .setDescription('Choose a game, or leave empty to fetch Steam prices for all games')
      .setRequired(false)
      .setAutocomplete(true)
  )
  .addStringOption((o) =>
    o
      .setName('source')
      .setDescription('Where to get the price')
      .setRequired(false)
      .addChoices(
        { name: 'Steam store', value: 'steam' },
        { name: 'Resellers (G2A, keys, best price)', value: 'resellers' }
      )
  )
  .addStringOption((o) =>
    o
      .setName('type')
      .setDescription('Key or Account (for resellers only)')
      .setRequired(false)
      .addChoices(
        { name: 'Key (CD key)', value: 'key' },
        { name: 'Account', value: 'account' },
        { name: 'Any', value: 'any' }
      )
  );

export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused();
  const games = searchGames(focused);
  await interaction.respond(
    games.map((g) => ({ name: getGameDisplayName(g), value: String(g.appId) }))
  );
}

/**
 * Fetch Steam store app details (including price) for an app ID.
 */
async function fetchSteamPrice(appId, cc = 'us') {
  const url = `${STEAM_APPDETAILS}?appids=${appId}&cc=${cc}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { error: `Steam returned ${res.status}` };
    const data = await res.json();
    const key = String(appId);
    const entry = data[key];
    if (!entry || !entry.success) return { error: 'Not on Steam store' };
    const d = entry.data || {};
    if (d.is_free) return { name: d.name, free: true };
    const price = d.price_overview;
    if (!price) return { name: d.name, error: 'No price (region)' };
    const discount = price.discount_percent ? Number(price.discount_percent) : 0;
    const priceStr =
      price.final_formatted || `${(price.final / 100).toFixed(2)} ${price.currency || 'USD'}`;
    return {
      name: d.name,
      price: priceStr,
      free: false,
      discount: discount > 0 ? discount : undefined,
    };
  } catch (err) {
    return { error: err?.message || 'Fetch failed' };
  }
}

/**
 * Fetch best price from CheapShark only for the exact game (steamAppID must match).
 * We never return a different game/DLC — only results from our list (by app ID).
 */
async function fetchCheapSharkBestPrice(gameName, steamAppId) {
  const url = `${CHEAPSHARK_GAMES}?title=${encodeQuery(gameName)}&pageSize=15`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { error: `CheapShark returned ${res.status}` };
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) return { error: 'No deals found' };
    const match = list.find((g) => g.steamAppID === String(steamAppId));
    if (!match) return { error: 'No deal for this exact game (list match only)' };
    const cheapest = match.cheapest;
    const dealId = match.cheapestDealID;
    const link = dealId ? `${CHEAPSHARK_REDIRECT}?dealID=${encodeURIComponent(dealId)}` : null;
    return {
      name: match.external || gameName,
      price: cheapest != null ? `$${Number(cheapest).toFixed(2)}` : null,
      link,
      gameID: match.gameID,
    };
  } catch (err) {
    return { error: err?.message || 'Fetch failed' };
  }
}

/**
 * Build reseller search links for a game (G2A, AllKeyShop, GG.deals).
 */
function resellerLinks(gameName, type) {
  const q = encodeQuery(gameName);
  const links = [];
  if (type === 'key' || type === 'any') {
    links.push({ label: 'G2A (Keys)', url: `https://www.g2a.com/search?query=${q}` });
  }
  if (type === 'account' || type === 'any') {
    links.push({ label: 'G2A (Accounts)', url: `https://www.g2a.com/search?query=${q}&account=1` });
  }
  if (type === 'any') {
    links.push({ label: 'AllKeyShop', url: `https://www.allkeyshop.com/blog/catalogue/search.php?q=${q}` });
    links.push({ label: 'GG.deals', url: `https://gg.deals/games/?query=${q}` });
  } else {
    links.push({ label: 'AllKeyShop', url: `https://www.allkeyshop.com/blog/catalogue/search.php?q=${q}` });
    links.push({ label: 'GG.deals', url: `https://gg.deals/games/?query=${q}` });
  }
  return links;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runBatched(tasks, concurrency, delayMs = 0) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((fn) => fn()));
    results.push(...batchResults);
    if (delayMs > 0 && i + concurrency < tasks.length) await delay(delayMs);
  }
  return results;
}

export async function execute(interaction) {
  const gameOption = interaction.options.getString('game');
  const source = (interaction.options.getString('source') || 'steam').toLowerCase();
  const type = (interaction.options.getString('type') || 'any').toLowerCase();

  const isResellers = source === 'resellers';

  if (isResellers && (gameOption == null || gameOption === '')) {
    return interaction.reply({
      content: 'For **Resellers** (G2A, keys, best price) please choose a **game** so we can show you the best deal and links to Key/Account stores.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (gameOption != null && gameOption !== '') {
    const appId = parseInt(gameOption, 10);
    const game = getGameByAppId(appId);
    if (!game) {
      return interaction.reply({ content: 'Game not found in the list.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (isResellers) {
      const cheap = await fetchCheapSharkBestPrice(game.name, game.appId);
      const links = resellerLinks(game.name, type);
      const linkLines = links.map((l) => `[${l.label}](${l.url})`).join(' • ');

      const embed = new EmbedBuilder()
        .setColor(0x72b01d)
        .setTitle(getGameDisplayName(game))
        .setDescription('Best price from key/reseller comparison (CheapShark) and links to compare **Keys** and **Accounts** on G2A, AllKeyShop, GG.deals.')
        .setTimestamp();

      if (cheap.error) {
        embed
          .setColor(0xfee75c)
          .addFields(
            { name: 'Best price', value: `*${cheap.error}*`, inline: false },
            { name: 'Compare yourself', value: linkLines, inline: false }
          )
          .setFooter({ text: `App ID: ${game.appId}` });
      } else {
        const bestLine = cheap.price
          ? `**${cheap.price}** — [View deal](${cheap.link || '#'})`
          : '—';
        embed
          .addFields(
            { name: 'Best price (approx)', value: bestLine, inline: false },
            { name: type === 'any' ? 'Keys & accounts' : type === 'key' ? 'Keys' : 'Accounts', value: linkLines, inline: false }
          )
          .setFooter({ text: `App ID: ${game.appId} • Prices vary by store and region` });
      }
      return interaction.editReply({ embeds: [embed] });
    }

    const steam = await fetchSteamPrice(game.appId);
    const storeUrl = `${STEAM_STORE_APP}/${game.appId}/`;

    if (steam.error) {
      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle(getGameDisplayName(game))
        .setDescription(`Could not load price: **${steam.error}**`)
        .addFields({ name: 'Store link', value: `[Open on Steam](${storeUrl})`, inline: false })
        .setFooter({ text: `App ID: ${game.appId}` })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    const priceText = steam.free ? 'Free' : steam.discount ? `${steam.price} (−${steam.discount}%)` : steam.price;
    const embed = new EmbedBuilder()
      .setColor(0x1b2838)
      .setTitle(getGameDisplayName({ ...game, name: steam.name || game.name }))
      .setDescription('Steam store price (USD).')
      .addFields(
        { name: 'Price', value: priceText, inline: true },
        { name: 'App ID', value: `\`${game.appId}\``, inline: true },
        { name: 'Store', value: `[Open on Steam](${storeUrl})`, inline: false }
      )
      .setFooter({ text: 'Prices may vary by region. Data from Steam store.' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  const allGames = loadGames();
  if (allGames.length === 0) {
    return interaction.reply({ content: 'No games in the list.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const tasks = allGames.map((g) => () => fetchSteamPrice(g.appId).then((r) => ({ game: g, steam: r })));
  const results = await runBatched(tasks, CONCURRENCY, DELAY_BETWEEN_BATCHES_MS);

  const withPrice = results.filter((r) => !r.steam.error && (r.steam.price || r.steam.free));
  const failed = results.filter((r) => r.steam.error);
  const sorted = [...withPrice].sort((a, b) => {
    const nameA = (a.steam.name || a.game.name).toLowerCase();
    const nameB = (b.steam.name || b.game.name).toLowerCase();
    return nameA.localeCompare(nameB);
  });

  const embeds = [];
  const totalFields = Math.min(sorted.length, FIELDS_PER_EMBED * MAX_EMBEDS);
  const chunks = [];
  for (let i = 0; i < totalFields; i += FIELDS_PER_EMBED) {
    chunks.push(sorted.slice(i, i + FIELDS_PER_EMBED));
  }

  chunks.forEach((chunk, idx) => {
    const embed = new EmbedBuilder()
      .setColor(0x1b2838)
      .setTitle(
        chunks.length > 1
          ? `Steam prices (${idx + 1}/${chunks.length})`
          : 'Steam prices — all games'
      )
      .setDescription(
        chunks.length === 1 && failed.length > 0
          ? `${withPrice.length} games with price. ${failed.length} could not be loaded. Use \`/pricegame source:Resellers\` with a game for keys/resellers.`
          : chunks.length === 1
            ? `${withPrice.length} games. USD, from Steam store. Use \`source: Resellers\` + a game for G2A/keys.`
            : null
      )
      .setTimestamp();

    chunk.forEach(({ game, steam }) => {
      const displayName = getGameDisplayName({ ...game, name: steam.name || game.name }).slice(0, 256);
      const value = steam.free
        ? 'Free'
        : steam.discount
          ? `${steam.price} (−${steam.discount}%)`
          : steam.price;
      embed.addFields({ name: displayName, value: value || '—', inline: true });
    });

    embed.setFooter({
      text:
        chunks.length > 1
          ? `Games ${idx * FIELDS_PER_EMBED + 1}–${idx * FIELDS_PER_EMBED + chunk.length} of ${sorted.length}`
          : failed.length > 0
            ? `${failed.length} game(s) had no price data`
            : 'Steam store. Use source: Resellers + game for keys/accounts.',
    });
    embeds.push(embed);
  });

  if (embeds.length === 0) {
    return interaction.editReply({
      content: `Could not load prices for any of the ${allGames.length} games. Try again later or use \`/pricegame game:<name>\` for a single game.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.editReply({ embeds });
}
