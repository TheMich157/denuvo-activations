import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  AttachmentBuilder,
} from 'discord.js';
import { getRequestByChannel, markScreenshotVerified } from '../services/requests.js';
import { verifyScreenshot } from '../services/screenshotVerify/index.js';
import {
  mergeDetection,
  recordFailure,
  clearState,
} from '../services/screenshotVerify/state.js';
import { config } from '../config.js';
import { fetchManifest, fetchLuaManifest, fetchSteamStoreInfo } from '../services/manifest.js';
import { checkRateLimit, getRemainingCooldown } from '../utils/rateLimit.js';
import { getGameByAppId, getGameDisplayName } from '../utils/games.js';
import {
  getPreorder,
  getClaim,
  submitClaim,
  verifyClaim,
  getOpenPreorders,
  getPreorderSpots,
  isPreorderFull,
  closePreorder,
  formatSpotsText,
  buildPreorderEmbed,
} from '../services/preorder.js';
import {
  logPreorderVerify,
  logPreorderStatus,
} from '../services/activationLog.js';
import { startVerificationInChannel } from '../services/verification.js';
import { addMessageXp, xpForLevel, getLevelTitle, getLevelEmoji, progressBar } from '../services/leveling.js';
import { getDiscountedPrice } from '../services/tiers.js';

const IMAGE_EXT = /\.(png|jpg|jpeg|webp|gif)(\?.*)?$/i;
const FAIL_THRESHOLD = 5;
const MANIFEST_RATE_LIMIT = 3;         // max requests
const MANIFEST_RATE_WINDOW = 60_000;   // per 60 seconds

function buildManualVerifyRow(channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`manual_verify_screenshot:${channelId}`)
      .setLabel('Approve manually')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✋')
  );
}

/* ──────────────── Tip Proof Verification ──────────────── */

/**
 * Extract text from an image using the available OCR provider.
 * Uses a specialized Ko-fi tip detection prompt for Groq.
 */
async function extractTextFromImage(url) {
  // Try Groq first with a specialized Ko-fi receipt prompt
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (apiKey) {
      const model = process.env.GROQ_MODEL?.trim() || 'meta-llama/llama-4-scout-17b-16e-instruct';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            max_tokens: 512,
            temperature: 0,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: `Analyze this screenshot of a payment receipt or donation page. Extract ALL text you can see. Focus especially on:
- Payment platform (Ko-fi, PayPal, Stripe, etc.)
- Dollar amounts (e.g. $5.00, 3.20 USD, €4)
- Words like: donation, tip, coffee, supporter, payment, bought, received, thank you, confirmed, success, complete
- Any reference numbers or order IDs
Return ONLY the raw extracted text, no commentary.` },
                { type: 'image_url', image_url: { url } },
              ],
            }],
          }),
        });
        clearTimeout(timeout);
        if (response.ok) {
          const data = await response.json();
          const text = data.choices?.[0]?.message?.content?.trim() || '';
          if (text) return text;
        }
      } catch {
        clearTimeout(timeout);
      }
    }
  } catch {}

  // Fall back to generic Groq OCR
  try {
    const { extractText: groqExtract } = await import('../services/screenshotVerify/providers/groq.js');
    const result = await groqExtract(url);
    if (!result.error && result.text) return result.text;
  } catch {}

  // Fall back to tesseract
  try {
    const { extractText: tesseractExtract } = await import('../services/screenshotVerify/providers/tesseract.js');
    const result = await tesseractExtract(url);
    if (!result.error && result.text) return result.text;
  } catch {}
  return '';
}

/**
 * Parse preorder ID from message text.
 * Supports: "preorder 5", "preorder #5", "#5", "po5", "po #5"
 */
function parsePreorderIdFromText(text) {
  const patterns = [
    /preorder\s*#?\s*(\d+)/i,
    /\bpo\s*#?\s*(\d+)/i,
    /#(\d+)/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Check if OCR text contains Ko-fi payment indicators and amount.
 * Returns { isKofi: boolean, amount: number | null }
 */
function detectKofiPayment(text) {
  const lower = text.toLowerCase();

  // Platform detection — broad matching for Ko-fi and other payment platforms
  const platformPatterns = [
    /ko[\s-]?fi/i,
    /kofi/i,
    /coffee/i,
    /supporter/i,
    /buy\s*me\s*a/i,
  ];
  const paymentPatterns = [
    /tip|donation|donat/i,
    /bought|received|thank/i,
    /payment|paid|purchase/i,
    /success|confirmed|complete/i,
    /receipt|transaction|order/i,
    /support(?:ed|ing|er)?/i,
    /contribut/i,
    /checkout/i,
    /one[\s-]?time/i,
  ];

  const isPlatform = platformPatterns.some(p => p.test(text));
  const isPayment = paymentPatterns.some(p => p.test(text));
  const isKofi = isPlatform || isPayment;

  // Extract dollar amounts — try many formats
  let amount = null;
  const amountPatterns = [
    // $5.00, $ 5.00, $5
    /\$\s*(\d+(?:\.\d{1,2})?)/,
    // 5.00 USD, 5 USD, 5.00 usd
    /(\d+(?:\.\d{1,2})?)\s*(?:USD|usd|dollars?)/i,
    // USD 5.00, USD5
    /(?:USD|usd|dollars?)\s*(\d+(?:\.\d{1,2})?)/i,
    // €5.00, €5
    /€\s*(\d+(?:\.\d{1,2})?)/,
    // 5.00 EUR, EUR 5.00
    /(\d+(?:\.\d{1,2})?)\s*(?:EUR|eur|euros?)/i,
    /(?:EUR|eur|euros?)\s*(\d+(?:\.\d{1,2})?)/i,
    // £5.00
    /£\s*(\d+(?:\.\d{1,2})?)/,
    // "amount: 5.00" or "total: 5.00" or "price: 5.00"
    /(?:amount|total|price|sum|cost|paid|payment)[\s:]*\$?\s*(\d+(?:\.\d{1,2})?)/i,
    // "5.00" near payment words (within 50 chars)
    /(?:paid|payment|donation|tip|bought|support)[\s\S]{0,50}?(\d+\.\d{2})/i,
    // Standalone decimal like "3.20" or "5.00" (common on receipts)
    /\b(\d{1,4}\.\d{2})\b/,
  ];

  for (const pattern of amountPatterns) {
    const match = text.match(pattern);
    if (match) {
      const parsed = parseFloat(match[1]);
      if (parsed > 0 && parsed < 10000) {
        amount = parsed;
        break;
      }
    }
  }

  return { isKofi, amount };
}

/**
 * Update the original preorder forum post embed with the latest spot counts.
 */
async function updatePreorderForumPost(client, preorder, preorderId) {
  if (!preorder.thread_id) return;
  try {
    const thread = await client.channels.fetch(preorder.thread_id).catch(() => null);
    if (!thread) return;
    const starterMessage = await thread.fetchStarterMessage().catch(() => null);
    if (!starterMessage) return;
    const updatedEmbed = buildPreorderEmbed({
      preorder, preorderId,
      kofiUrl: config.kofiUrl,
      tipChannelId: config.tipVerifyChannelId,
    });
    await starterMessage.edit({ embeds: [updatedEmbed] }).catch(() => {});
  } catch {}
}

async function handleTipVerification(message) {
  if (!config.tipVerifyChannelId || message.channelId !== config.tipVerifyChannelId) return false;

  // Must have an image attachment
  const attachment = message.attachments.find((a) => IMAGE_EXT.test(a.url));
  if (!attachment) {
    // If just text with a preorder mention but no image
    const preorderId = parsePreorderIdFromText(message.content);
    if (preorderId) {
      // Fetch the preorder to show its actual price (may differ from the global default)
      const po = getPreorder(preorderId);
      const poPrice = po?.price || config.minDonation;
      const userPrice = getDiscountedPrice(poPrice, message.author.id);
      const priceStr = userPrice < poPrice ? `$${userPrice.toFixed(2)} (your tier price)` : `$${poPrice.toFixed(2)}`;
      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle('📸 Proof Required')
        .setDescription(
          `Please attach a **screenshot** of your Ko-fi tip/donation receipt for preorder **#${preorderId}**.\n\n` +
          `The screenshot should clearly show the payment amount (${priceStr}+ minimum).`
        )
        .setTimestamp();
      await message.reply({ embeds: [embed] });
      return true;
    }
    return false; // Not relevant
  }

  // Try to detect which preorder this is for
  let preorderId = parsePreorderIdFromText(message.content);

  await message.react('🔍').catch(() => {});

  // OCR the image to detect Ko-fi payment info
  const ocrText = await extractTextFromImage(attachment.url);
  const { isKofi, amount } = detectKofiPayment(ocrText);

  // If no preorder ID in message, try to find it from OCR text
  if (!preorderId) {
    preorderId = parsePreorderIdFromText(ocrText);
  }

  // If still no preorder ID, check if there's only one open preorder (auto-detect)
  if (!preorderId) {
    const open = getOpenPreorders();
    if (open.length === 1) {
      preorderId = open[0].id;
    }
  }

  // Remove search reaction
  await message.reactions.cache.get('🔍')?.users?.remove(message.client.user.id).catch(() => {});

  if (!preorderId) {
    await message.react('❓').catch(() => {});
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('❓ Which Preorder?')
      .setDescription(
        'Could not determine which preorder this tip is for.\n\n' +
        'Please include the preorder number in your message, e.g.:\n' +
        '`preorder #5` or just `#5`'
      )
      .setTimestamp();
    await message.reply({ embeds: [embed] });
    return true;
  }

  const preorder = getPreorder(preorderId);
  if (!preorder) {
    await message.react('❌').catch(() => {});
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setDescription(`Preorder **#${preorderId}** was not found.`)
          .setTimestamp(),
      ],
    });
    return true;
  }

  if (preorder.status !== 'open') {
    await message.react('❌').catch(() => {});
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setDescription(`Preorder **#${preorderId}** (${preorder.game_name}) is **${preorder.status}** — no longer accepting donations.`)
          .setTimestamp(),
      ],
    });
    return true;
  }

  // Check if already verified
  const existingClaim = getClaim(preorderId, message.author.id);
  if (existingClaim && existingClaim.verified) {
    await message.react('ℹ️').catch(() => {});
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x3498db)
          .setDescription(`You already have a **verified** spot on preorder **#${preorderId}** (${preorder.game_name}). You'll be notified when it's fulfilled!`)
          .setTimestamp(),
      ],
    });
    return true;
  }

  // Determine verification — use preorder-specific price & apply tier discount
  const basePrice = preorder.price || config.minDonation;
  const minDonation = getDiscountedPrice(basePrice, message.author.id);
  const meetsAmount = amount !== null && amount >= minDonation;
  const autoVerified = isKofi && meetsAmount;

  if (autoVerified) {
    // Auto-verify — create claim if they didn't use the button, then verify
    if (!existingClaim) {
      submitClaim(preorderId, message.author.id, message.id);
    }
    verifyClaim(preorderId, message.author.id);
    await message.react('✅').catch(() => {});

    const spots = getPreorderSpots(preorderId);
    const spotsText = formatSpotsText(spots);

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅ Tip Verified — Spot Confirmed!')
      .setDescription(
        [
          `Payment of **$${amount.toFixed(2)}** detected for preorder **#${preorderId}** (${preorder.game_name}).`,
          '',
          '**Your spot is now confirmed!** You\'ll be notified when the preorder is fulfilled.',
          '',
          `🎟️ ${spotsText}`,
        ].join('\n')
      )
      .setFooter({ text: `Auto-verified • Preorder #${preorderId}` })
      .setTimestamp();
    await message.reply({ embeds: [embed] });

    // Log
    logPreorderVerify({ preorderId, gameName: preorder.game_name, userId: message.author.id, amount, method: 'auto', verifiedBy: null }).catch(() => {});

    // DM the user
    try {
      await message.author.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle('✅ Spot Confirmed!')
            .setDescription(
              [
                `Your **$${amount.toFixed(2)}** donation for preorder **#${preorderId}** (${preorder.game_name}) has been **auto-verified**!`,
                '',
                '**Your spot is confirmed.** You\'ll receive a DM when the preorder is fulfilled and your activation is ready.',
                '',
                `🎟️ ${spotsText}`,
              ].join('\n')
            )
            .setFooter({ text: `Preorder #${preorderId}` })
            .setTimestamp(),
        ],
      }).catch(() => {});
    } catch {}

    // Update the forum post embed with new spot counts
    await updatePreorderForumPost(message.client, preorder, preorderId);

    // Notify the preorder thread
    if (preorder.thread_id) {
      try {
        const thread = await message.client.channels.fetch(preorder.thread_id).catch(() => null);
        if (thread) {
          await thread.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0x57f287)
                .setDescription(`✅ <@${message.author.id}>'s **$${amount.toFixed(2)}** tip verified — spot confirmed!\n🎟️ ${spotsText}`)
                .setTimestamp(),
            ],
          });
        }
      } catch {}
    }

    // Auto-close if all spots filled
    if (isPreorderFull(preorderId)) {
      closePreorder(preorderId);
      logPreorderStatus({ preorderId, gameName: preorder.game_name, action: 'closed', actor: message.client.user.id, spotsInfo: spots }).catch(() => {});
      await updatePreorderForumPost(message.client, { ...preorder, status: 'closed' }, preorderId);
      if (preorder.thread_id) {
        try {
          const thread = await message.client.channels.fetch(preorder.thread_id).catch(() => null);
          if (thread) {
            await thread.send({
              embeds: [
                new EmbedBuilder()
                  .setColor(0xe67e22)
                  .setTitle('🔒 Preorder Full — Auto-Closed')
                  .setDescription(`All **${spots.total}** spots have been filled! This preorder is now closed.`)
                  .setTimestamp(),
              ],
            });
          }
        } catch {}
      }
    }
  } else {
    // Needs manual review — detected partial info or failed OCR
    // Create a pending claim if they didn't use the button
    if (!existingClaim) {
      submitClaim(preorderId, message.author.id, message.id);
    }

    await message.react('⏳').catch(() => {});

    const issues = [];
    if (!isKofi) issues.push('• Could not detect Ko-fi payment in the screenshot');
    if (amount === null) issues.push('• Could not detect the payment amount');
    else if (amount < minDonation) issues.push(`• Amount detected (**$${amount.toFixed(2)}**) is below the minimum **$${minDonation.toFixed(2)}**`);

    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('⏳ Pending Manual Verification')
      .setDescription(
        [
          `Tip proof submitted for preorder **#${preorderId}** (${preorder.game_name}).`,
          '',
          '**Issues detected:**',
          ...issues,
          '',
          'An activator will manually review your proof shortly.',
          'Your spot is reserved but **not yet confirmed** — awaiting staff verification.',
          `Minimum donation: **$${minDonation.toFixed(2)}** on [Ko-fi](${config.kofiUrl})`,
        ].join('\n')
      )
      .setFooter({ text: `Preorder #${preorderId} • Pending review` })
      .setTimestamp();

    // Add manual verify button for activators
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`verify_tip:${preorderId}:${message.author.id}`)
        .setLabel('Verify — confirm spot')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅'),
      new ButtonBuilder()
        .setCustomId(`reject_tip:${preorderId}:${message.author.id}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('❌'),
    );

    await message.reply({ embeds: [embed], components: [row] });

    // Update forum post to show new claimed count
    await updatePreorderForumPost(message.client, preorder, preorderId);
  }

  return true;
}

async function handleManifestRequest(message) {
  if (!config.manifestChannelId || message.channelId !== config.manifestChannelId) return false;
  if (!config.ryuuApiKey) return false;

  const content = message.content.trim().toLowerCase();
  // Accept: "500" (manifest download) or "500 lua" (Lua script)
  const luaMatch = content.match(/^(\d+)\s+lua$/);
  const plainMatch = content.match(/^(\d+)$/);
  const appIdMatch = luaMatch || plainMatch;
  const isLua = !!luaMatch;

  if (!appIdMatch) {
    const helpEmbed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('📦 Manifest Request')
      .setDescription(
        'Send a **Steam App ID** to download the game manifest.\n\n' +
        '**Commands:**\n' +
        '`500` — Download manifest file\n' +
        '`500 lua` — Get Lua manifest script\n\n' +
        'You can find App IDs on [SteamDB](https://steamdb.info/) or the Steam store URL.'
      )
      .setTimestamp();
    await message.reply({ embeds: [helpEmbed] });
    return true;
  }

  // Rate limit: prevent spam
  if (!checkRateLimit(message.author.id, 'manifest', MANIFEST_RATE_LIMIT, MANIFEST_RATE_WINDOW)) {
    const remaining = getRemainingCooldown(message.author.id, 'manifest');
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle('⏳ Slow down')
          .setDescription(`You can request **${MANIFEST_RATE_LIMIT}** manifests per minute. Try again in **${remaining}s**.`)
          .setTimestamp(),
      ],
    });
    return true;
  }

  const appId = appIdMatch[1];
  const modeLabel = isLua ? 'Lua manifest' : 'manifest';

  // Show loading reaction + pending embed
  await message.react('📦').catch(() => {});

  const pendingEmbed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📦 Fetching ${isLua ? 'Lua Manifest' : 'Manifest'}…`)
    .setDescription(`Downloading ${modeLabel} for App ID **${appId}**. Please wait…`)
    .setFooter({ text: `Requested by ${message.author.displayName || message.author.username}` })
    .setTimestamp();
  const pendingMsg = await message.reply({ embeds: [pendingEmbed] });

  try {
    // Fetch Steam store info in parallel with the manifest download
    const storeInfoPromise = fetchSteamStoreInfo(appId).catch(() => null);

    const clearLoading = async () => {
      await message.reactions.cache.get('📦')?.users?.remove(message.client.user.id).catch(() => {});
      await message.react('✅').catch(() => {});
    };

    /** Build a game-info enriched embed. Name is hyperlinked to Steam store. */
    const buildGameEmbed = (storeInfo, color, title) => {
      const embed = new EmbedBuilder().setColor(color).setTimestamp();
      if (storeInfo) {
        embed.setTitle(title);
        embed.setURL(storeInfo.url);
        embed.setDescription(storeInfo.description);
        embed.setThumbnail(storeInfo.headerImage);
        embed.addFields(
          { name: '🎮 Game', value: `[${storeInfo.name}](${storeInfo.url})`, inline: true },
          { name: '🏷️ App ID', value: `\`${appId}\``, inline: true },
          { name: '💰 Price', value: storeInfo.price, inline: true },
          { name: '🎭 Genre', value: storeInfo.genres, inline: false },
        );
      } else {
        // Fallback if Steam API failed
        const knownGame = getGameByAppId(parseInt(appId, 10));
        const gameName = knownGame ? getGameDisplayName(knownGame) : null;
        embed.setTitle(title);
        if (gameName) {
          embed.setDescription(`**${gameName}** (\`${appId}\`)`);
        } else {
          embed.setDescription(`App ID \`${appId}\``);
        }
      }
      embed.setFooter({ text: `Requested by ${message.author.displayName || message.author.username}` });
      return embed;
    };

    // Check if this game requires Denuvo activation (exists in list.json)
    const denuvoGame = getGameByAppId(parseInt(appId, 10));

    // Helper: send Denuvo warning before the manifest embed
    const sendDenuvoWarning = async () => {
      if (!denuvoGame) return;
      const warnEmbed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle('⚠️ Denuvo Activation Required')
        .setDescription(
          `**${getGameDisplayName(denuvoGame)}** uses **Denuvo DRM** and will not work without an activation.\n\n` +
          `Head over to <#1469390899162382510> to request an activation code.`
        )
        .setTimestamp();
      await message.channel.send({ embeds: [warnEmbed] });
    };

    if (isLua) {
      const [{ script }, storeInfo] = await Promise.all([fetchLuaManifest(appId), storeInfoPromise]);
      await clearLoading();
      await sendDenuvoWarning();

      if (script.length <= 1500) {
        const embed = buildGameEmbed(storeInfo, 0x57f287, '✅ Lua Manifest Ready');
        embed.addFields({ name: '📜 Script', value: `\`\`\`lua\n${script}\n\`\`\``, inline: false });
        await pendingMsg.edit({ embeds: [embed] });
      } else {
        const attachment = new AttachmentBuilder(Buffer.from(script, 'utf-8'), { name: `manifest_${appId}.lua` });
        const embed = buildGameEmbed(storeInfo, 0x57f287, '✅ Lua Manifest Ready');
        embed.addFields({ name: '📏 Size', value: `${(Buffer.byteLength(script) / 1024).toFixed(1)} KB`, inline: true });
        await pendingMsg.edit({ embeds: [embed], files: [attachment] });
      }
    } else {
      const [result, storeInfo] = await Promise.all([fetchManifest(appId), storeInfoPromise]);
      await clearLoading();
      await sendDenuvoWarning();

      if (result.type === 'file') {
        const sizeLabel = `${(result.buffer.length / 1024 / 1024).toFixed(2)} MB`;
        const attachment = new AttachmentBuilder(result.buffer, { name: result.filename });
        const embed = buildGameEmbed(storeInfo, 0x57f287, '✅ Manifest Ready');
        embed.addFields(
          { name: '📁 File', value: `\`${result.filename}\``, inline: true },
          { name: '📏 Size', value: sizeLabel, inline: true },
        );
        if (result.compressed) {
          embed.addFields({ name: '🗜️ Note', value: 'File was compressed (`.gz`) to fit Discord limits. Extract with 7-Zip or `gzip -d`.', inline: false });
        }
        await pendingMsg.edit({ embeds: [embed], files: [attachment] });
      } else {
        const jsonStr = JSON.stringify(result.data, null, 2);
        if (jsonStr.length <= 1500) {
          const embed = buildGameEmbed(storeInfo, 0x57f287, '✅ Manifest Ready');
          embed.addFields({ name: '📄 Data', value: `\`\`\`json\n${jsonStr}\n\`\`\``, inline: false });
          await pendingMsg.edit({ embeds: [embed] });
        } else {
          const attachment = new AttachmentBuilder(Buffer.from(jsonStr, 'utf-8'), { name: `manifest_${appId}.json` });
          const embed = buildGameEmbed(storeInfo, 0x57f287, '✅ Manifest Ready');
          embed.addFields({ name: '📏 Size', value: `${(Buffer.byteLength(jsonStr) / 1024).toFixed(1)} KB`, inline: true });
          await pendingMsg.edit({ embeds: [embed], files: [attachment] });
        }
      }
    }

  } catch (err) {
    const errMsg = err.message || 'Unknown error';
    const isTooLarge = /too large|entity too large|413/i.test(errMsg);

    // If manifest is too large, try Lua fallback (Lua scripts are much smaller)
    if (isTooLarge && !isLua) {
      try {
        const [{ script }, storeInfo] = await Promise.all([fetchLuaManifest(appId), storeInfoPromise]);
        await clearLoading();
        await sendDenuvoWarning();

        const attachment = new AttachmentBuilder(Buffer.from(script, 'utf-8'), { name: `manifest_${appId}.lua` });
        const embed = buildGameEmbed(storeInfo, 0xfee75c, '⚠️ Manifest Too Large — Lua Fallback');
        embed.addFields(
          { name: '📜 File', value: `\`manifest_${appId}.lua\``, inline: true },
          { name: '📏 Size', value: `${(Buffer.byteLength(script) / 1024 / 1024).toFixed(2)} MB`, inline: true },
          { name: '💡 Note', value: 'The `.manifest` file was too large for the API. A `.lua` script has been provided instead.\nPlace it in `Steam\\config\\stplug-in`.', inline: false },
          { name: '🔗 Manual Download', value: `[Download from Ryuu Generator](https://generator.ryuu.lol/) — search for App ID \`${appId}\``, inline: false },
        );
        await pendingMsg.edit({ embeds: [embed], files: [attachment] });
        return true;
      } catch {
        // Lua fallback also failed — fall through to error embed
      }
    }

    await message.reactions.cache.get('📦')?.users?.remove(message.client.user.id).catch(() => {});
    await message.react('❌').catch(() => {});

    const storeInfo = await fetchSteamStoreInfo(appId).catch(() => null);
    const errorEmbed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle(`❌ ${isLua ? 'Lua Manifest' : 'Manifest'} Failed`)
      .setTimestamp();
    if (storeInfo) {
      errorEmbed.setDescription(`Could not fetch ${modeLabel} for [${storeInfo.name}](${storeInfo.url}) (\`${appId}\`).`);
      errorEmbed.setThumbnail(storeInfo.headerImage);
    } else {
      errorEmbed.setDescription(`Could not fetch ${modeLabel} for App ID **${appId}**.`);
    }
    errorEmbed.addFields({ name: 'Error', value: errMsg, inline: false });
    if (isTooLarge) {
      errorEmbed.addFields({
        name: '🔗 Manual Download',
        value: `This manifest is too large for the API. Download it directly from [Ryuu Generator](https://generator.ryuu.lol/) — search for App ID \`${appId}\`.`,
        inline: false,
      });
    }
    errorEmbed.setFooter({ text: 'Check the App ID and try again' });
    await pendingMsg.edit({ embeds: [errorEmbed] });
  }
  return true;
}

export async function handleMessage(message) {
  if (message.author.bot || !message.guild) return;

  // ── Leveling XP ──────────────────────────────────────────
  try {
    const result = addMessageXp(message.author.id);
    if (result && result.leveledUp) {
      const title = getLevelTitle(result.newLevel);
      const emoji = getLevelEmoji(result.newLevel);
      const needed = xpForLevel(result.newLevel);
      const bar = progressBar(result.xp, needed, 12);
      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setAuthor({ name: message.author.displayName, iconURL: message.author.displayAvatarURL({ size: 64 }) })
        .setDescription(
          [
            `${emoji} <@${message.author.id}> leveled up to **Level ${result.newLevel}** — *${title}*!`,
            `\`${bar}\` 0 / ${needed.toLocaleString()} XP`,
          ].join('\n')
        )
        .setTimestamp();
      // Send in the same channel where they sent the message
      await message.channel.send({
        content: `🎉 **Level up!** <@${message.author.id}> reached **Level ${result.newLevel}** in this channel.`,
        embeds: [embed],
      }).catch((err) => console.error('[Leveling] Failed to send level-up message:', err?.message));
    }
  } catch (err) {
    console.error('[Leveling] XP error:', err.message);
  }

  // Handle verification channel — user pings the bot to start quiz
  if (config.verifyChannelId && message.channelId === config.verifyChannelId) {
    if (message.mentions.has(message.client.user)) {
      try {
        await startVerificationInChannel(message);
      } catch (err) {
        console.error('[Verify] Error starting verification:', err.message);
      }
    }
    return; // Don't process other handlers for messages in the verify channel
  }

  // Handle tip proof verification in the designated channel
  if (await handleTipVerification(message)) return;

  // Handle manifest requests in the designated channel
  if (await handleManifestRequest(message)) return;

  const req = getRequestByChannel(message.channelId);
  if (!req || req.buyer_id !== message.author.id) return;

  const attachment = message.attachments.find((a) => IMAGE_EXT.test(a.url));
  if (!attachment) return;

  const result = await verifyScreenshot(attachment.url, req.game_name);
  if (result.gameMismatch) {
    const expected = req.game_name;
    const msg =
      'detectedGame' in result.gameMismatch
        ? `Your screenshot shows the game folder for **${result.gameMismatch.detectedGame}**, but this ticket is for **${expected}**. Please post a screenshot of the **${expected}** game folder (Properties and WUB).`
        : `We couldn't find **${expected}** in your screenshot. Please post a screenshot that clearly shows the **${expected}** game folder (right‑click → Properties) and WUB.`;
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('📸 Wrong game in screenshot')
      .setDescription(msg)
      .setFooter({ text: 'The folder name in your screenshot must match the game you requested.' })
      .setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }
  const merged = mergeDetection(message.channelId, {
    hasProperties: result.hasProperties,
    hasWub: result.hasWub,
  });

  const verified = merged.hasProperties && merged.hasWub;

  if (result.error) {
    const failCount = recordFailure(message.channelId, merged);
    const showManual = failCount >= FAIL_THRESHOLD;
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('📸 Screenshot received – verification failed')
      .setDescription(
        'Could not auto-verify this screenshot. ' +
          (showManual
            ? '**Activators:** You may approve manually using the button below.'
            : 'Activators: please verify the screenshot manually before claiming.')
      )
      .addFields(
        { name: 'Reason', value: result.error, inline: false },
        {
          name: 'Attempts',
          value: `${failCount}/${FAIL_THRESHOLD}`,
          inline: true,
        },
        {
          name: 'Provider',
          value: result.provider || '—',
          inline: true,
        }
      )
      .setTimestamp();
    const payload = { embeds: [embed] };
    if (showManual) payload.components = [buildManualVerifyRow(message.channelId)];
    await message.reply(payload);
    return;
  }

  if (verified) {
    markScreenshotVerified(req.id);
    clearState(message.channelId);
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅ Screenshot verified')
      .addFields(
        {
          name: 'Game folder Properties',
          value: '✓ Detected',
          inline: true,
        },
        {
          name: 'WUB (updates paused + red shield)',
          value: '✓ Detected',
          inline: true,
        },
        {
          name: 'Status',
          value: 'Ready for activator to claim.',
          inline: false,
        }
      )
      .setFooter({ text: result.provider ? `Verified via ${result.provider}` : 'Verification complete' })
      .setTimestamp();
    await message.reply({ embeds: [embed] });
    return;
  }

  const failCount = recordFailure(message.channelId, merged);
  const showManual = failCount >= FAIL_THRESHOLD;

  const progress = (merged.hasProperties ? 1 : 0) + (merged.hasWub ? 1 : 0);
  const providerText = result.provider ? ` via ${result.provider}` : '';

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('📸 Screenshot received – partial')
    .setDescription(merged.isNewProgress
      ? 'Some elements were detected. Progress saved — you can post another screenshot to add the rest.'
      : 'Add the missing element(s) and post an updated screenshot.')
    .addFields(
      {
        name: 'Game folder Properties',
        value: merged.hasProperties ? '✓ Detected' : '○ Missing — right‑click folder → Properties',
        inline: true,
      },
      {
        name: 'WUB (updates paused + red shield/X)',
        value: merged.hasWub ? '✓ Detected' : '○ Missing — WUB with updates paused **and red shield with X icon**',
        inline: true,
      },
      {
        name: 'Progress',
        value: `${progress}/2 detected${providerText}`,
        inline: true,
      },
      {
        name: 'Attempts',
        value: `${failCount}/${FAIL_THRESHOLD}`,
        inline: true,
      }
    )
    .setTimestamp();

  const payload = { embeds: [embed] };
  if (showManual) payload.components = [buildManualVerifyRow(message.channelId)];
  await message.reply(payload);
}
