import { SlashCommandBuilder, EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { config } from '../config.js';
import { TIERS } from '../services/tiers.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('info')
  .setDescription('Post the full server information panel to the current channel')
  .setContexts(0);

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const kofiUrl = config.kofiUrl || 'https://ko-fi.com/denubrew';
  const drmUrl = 'https://drm.steam.run';

  // ─── 1. Welcome & Overview ───
  const welcomeEmbed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎮 Welcome to DenuBrew — Denuvo Activation Service')
    .setDescription([
      '**DenuBrew** provides Denuvo DRM activation tokens for your legitimately owned Steam games.',
      'Our verified activator team handles everything — you just provide the game and follow the steps.',
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      '**What is an activation token?**',
      'Denuvo-protected games require online activation tokens. If you\'ve used your activations ' +
      '(e.g. after hardware changes or reinstalls), you need a new token. That\'s where we come in.',
      '',
      '**What do we need from you?**',
      '• Your **Steam Account** must own the game',
      '• **Windows Update Blocker (WUB)** must be active — updates disabled, red shield icon visible',
      '• A **screenshot** proving both: game folder properties + WUB active',
      '• **Patience** — activators work through the queue in order (supporters get priority!)',
      '',
      '**What you get:**',
      '• A one-time auth code valid for **30 minutes**',
      '• The code lets you play your Denuvo game offline',
      '• Fast turnaround from our activator team',
    ].join('\n'))
    .setTimestamp();

  // ─── 2. Step-by-Step Activation Guide ───
  const guideEmbed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('📖 Step-by-Step Activation Guide')
    .setDescription([
      '**Before you start — make sure you have:**',
      '✅ The game installed via Steam',
      '✅ Windows Update Blocker (WUB) downloaded & active',
      '✅ Your screenshot ready (see requirements below)',
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      '**Step 1 — Prepare WUB**',
      'Download WUB from [wub.zip](https://www.sordum.org/9470/) and run it. Click the red shield ' +
      'to disable Windows Updates. You should see a **red shield with an X** icon.',
      '',
      '**Step 2 — Take Your Screenshot**',
      'Your screenshot must show **both** of these at the same time:',
      '> 📁 Right-click your game install folder → **Properties** dialog open',
      '> 🛡️ WUB showing the **red shield with X** (updates disabled)',
      '',
      '**Step 3 — Open a Ticket**',
      'Use the **ticket panel** or type `/activate` and select your game.',
      '',
      '**Step 4 — Upload Your Screenshot**',
      'Post your screenshot in the ticket channel. The bot verifies it automatically.',
      '> ⏰ You have **5 minutes** to upload or the ticket auto-closes.',
      '',
      '**Step 5 — Receive Your Code**',
      'An activator will claim your ticket and generate your auth code.',
      'Enter the code in `drm.steam.run` or directly in the game\'s DRM prompt.',
      '> ⏱️ Codes expire in **30 minutes** — use it promptly!',
      '',
      '**Step 6 — Confirm & Rate**',
      'Click **Code worked** to confirm. Rate your activator to help us improve!',
    ].join('\n'));

  // ─── 3. Required Tools & Downloads ───
  const toolsEmbed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('🔧 Required Tools & Links')
    .addFields(
      {
        name: '🛡️ Windows Update Blocker (WUB)',
        value: [
          'Prevents Windows from re-enabling Denuvo checks.',
          '**Download:** [sordum.org/9470](https://www.sordum.org/9470/)',
          '• Run → click **Disable Updates** → red shield with X',
          '• Must be active in your screenshot',
        ].join('\n'),
        inline: false,
      },
      {
        name: '🌐 DRM Steam Run',
        value: [
          `The portal for manual auth code entry: **[drm.steam.run](${drmUrl})**`,
          '• Login with your Steam account',
          '• Enter your game\'s App ID',
          '• Copy the auth code from your ticket',
        ].join('\n'),
        inline: false,
      },
      {
        name: '🎮 Finding Your Game\'s App ID',
        value: [
          '• Open your game\'s **Steam Store** page',
          '• The URL contains the App ID: `store.steampowered.com/app/XXXXXX`',
          '• Or use [SteamDB](https://steamdb.info/) to search',
        ].join('\n'),
        inline: false,
      },
      {
        name: '📸 Screenshot Requirements',
        value: [
          'Your screenshot must show **both**:',
          '1. Game folder → right-click → **Properties** dialog (visible)',
          '2. WUB with **red shield + X** icon',
          '',
          '> ❌ Blurry / cropped / edited screenshots will be rejected',
        ].join('\n'),
        inline: false,
      }
    );

  // ─── 4. Ko-fi Tiers & How to Purchase ───
  const tierLines = [];
  for (const [key, t] of Object.entries(TIERS)) {
    if (key === 'none') continue;
    tierLines.push([
      `${t.emoji} **${t.label}**`,
      `├ ⏱️ Cooldown reduction: **${Math.round(t.cooldownReduction * 100)}%**`,
      `├ 🚀 Queue priority bonus: **+${t.priorityBonus}**`,
      `├ 💸 Preorder discount: **${t.preorderDiscount > 0 ? Math.round(t.preorderDiscount * 100) + '%' : '—'}**`,
      `└ 📋 Waitlist priority: ${t.waitlistPriority ? '✅ Notified first' : '❌'}`,
    ].join('\n'));
  }

  const tierEmbed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle('☕ Ko-fi Supporter Tiers — How to Purchase')
    .setDescription([
      `Support the project and unlock exclusive perks by subscribing on **[Ko-fi](${kofiUrl}/tiers)**!`,
      '',
      '**How to subscribe:**',
      `1. Visit **[${kofiUrl}/tiers](${kofiUrl}/tiers)**`,
      '2. Choose your tier (Low / Mid / High)',
      '3. Complete the payment on Ko-fi',
      '4. DM a staff member or post in the verification channel with proof',
      '5. Staff will assign your tier role — benefits apply immediately!',
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      ...tierLines,
      '',
      '> 💡 Tier benefits stack with other perks. Higher tiers = faster service!',
      '> 🔄 Tiers are subscription-based — support us monthly to keep your benefits.',
    ].join('\n'))
    .setURL(`${kofiUrl}/tiers`);

  // ─── 5. Preorder System ───
  const preorderEmbed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('🛒 Preorder System — Reserve Activations Early')
    .setDescription([
      'Preorders let you **reserve a spot** for upcoming or high-demand games before they\'re available.',
      '',
      '**How preorders work:**',
      `1. Browse open preorders in the **preorder forum channel**`,
      '2. Click **Claim Spot** on a preorder you want',
      `3. Donate the listed amount on **[Ko-fi](${kofiUrl})**`,
      `4. Post your Ko-fi receipt screenshot in the **tip verification channel**`,
      '5. Include `#preorderID` in your message (e.g. `#42`)',
      '6. Bot auto-verifies your tip — or staff manually reviews',
      '7. Once verified, your spot is locked in!',
      '8. When the game is ready, **tickets auto-open** for all verified users',
      '',
      '> 💸 **Tier discounts apply!** Mid Tier gets 10% off, High Tier gets 20% off preorder prices.',
      `> ☕ **Donate here:** [${kofiUrl}](${kofiUrl})`,
    ].join('\n'));

  // ─── 6. Commands Reference ───
  const cmdEmbed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('📋 All Commands')
    .addFields(
      {
        name: '🎮 Activation',
        value: [
          '`/activate` — Open a new activation ticket',
          '`/profile [@user]` — View profile, credits, tier, history',
          '`/stats` — Server-wide activation statistics',
          '`/leaderboard` — Points leaderboard',
        ].join('\n'),
        inline: false,
      },
      {
        name: '🗳️ Community',
        value: [
          '`/vote suggest <game>` — Suggest a game to be added',
          '`/vote up <id>` — Vote for a game suggestion',
          '`/vote list` — View top voted games',
        ].join('\n'),
        inline: true,
      },
      {
        name: '🛒 Preorders',
        value: [
          '`/preorder list` — View open preorders',
        ].join('\n'),
        inline: true,
      },
      {
        name: '🛠️ Staff Commands',
        value: [
          '`/tier set/remove/list` — Manage Ko-fi tiers',
          '`/warn add/list/remove/clear` — Manage warnings',
          '`/giveaway create/list/end` — Run giveaways',
          '`/bulkcode <appid>` — Bulk distribute codes',
          '`/audit @user` — Full user audit trail',
          '`/schedule set/view/clear` — Activator availability',
          '`/preorder create/close/fulfill/refill` — Manage preorders',
          '`/waitlist list/remove` — Manage waitlist',
          '`/blacklist` — Manage blacklisted users',
          '`/away` — Toggle away status',
        ].join('\n'),
        inline: false,
      }
    );

  // ─── 7. Rules & Warnings ───
  const rulesEmbed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('📜 Server Rules & Warning System')
    .setDescription([
      '**Rules — breaking any of these may result in warnings or a ban:**',
      '',
      '1. 🤝 **Be respectful** — No toxicity, harassment, or disrespect toward staff or members.',
      '2. 🔒 **No sharing codes** — Auth codes are personal. Never share, sell, or redistribute them.',
      '3. 🎫 **One ticket at a time** — Wait for your current request before opening another.',
      '4. ⏳ **Be patient** — Activators work through the queue. Ko-fi supporters get priority!',
      '5. ✅ **Accurate info only** — Provide correct Steam credentials and screenshots.',
      '6. 🚫 **No spam** — Don\'t flood channels, spam commands, or create duplicate tickets.',
      '7. 🏴‍☠️ **Legit ownership** — You must legitimately own the game on Steam.',
      '8. 📸 **Valid screenshots** — Faked or edited screenshots = instant warning.',
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      '**⚠️ Warning System:**',
      '• Each violation earns a **warning** (staff discretion)',
      '• Warnings are logged and visible on your `/profile`',
      '• **3 warnings = automatic blacklist** — you lose access to all services',
      '• Blacklisted users cannot open tickets, claim preorders, or use commands',
      '',
      '> Appeals: Contact a staff member if you believe a warning was issued in error.',
    ].join('\n'));

  // ─── 8. FAQ ───
  const faqEmbed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('❓ Frequently Asked Questions')
    .addFields(
      {
        name: 'What is Denuvo?',
        value: 'Denuvo is a DRM (Digital Rights Management) system used by some games. It limits offline activations — we help you get new tokens.',
        inline: false,
      },
      {
        name: 'Is this free?',
        value: 'Yes! Standard activations are completely free. Preorders require a small Ko-fi donation. Ko-fi tiers are optional for priority perks.',
        inline: false,
      },
      {
        name: 'Why do I need WUB?',
        value: 'Windows Updates can silently re-trigger Denuvo checks, consuming your activations. WUB prevents this.',
        inline: false,
      },
      {
        name: 'How long does an activation take?',
        value: 'Depends on the queue. Usually minutes, sometimes up to a few hours during busy times. Ko-fi supporters get served faster!',
        inline: false,
      },
      {
        name: 'My code didn\'t work!',
        value: 'Press **Help** in your ticket. Codes expire in 30 minutes — make sure to use it immediately. If it still fails, an activator will assist.',
        inline: false,
      },
      {
        name: 'Can I get multiple games activated?',
        value: 'Yes, but one at a time. Complete your current ticket before opening another. There\'s a cooldown between requests for the same game.',
        inline: false,
      },
      {
        name: 'What games are available?',
        value: 'Check the **ticket panel** or use `/activate` to see the full list. You can also `/vote suggest` a game you want added!',
        inline: false,
      },
      {
        name: 'How do I get verified to use the server?',
        value: 'New members receive a **verification quiz** via DM when they join. Answer the questions correctly to gain access. This keeps the server safe from bots!',
        inline: false,
      }
    );

  // ─── Buttons ───
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('☕ Donate on Ko-fi')
      .setStyle(ButtonStyle.Link)
      .setURL(kofiUrl),
    new ButtonBuilder()
      .setLabel('🏆 View Tiers')
      .setStyle(ButtonStyle.Link)
      .setURL(`${kofiUrl}/tiers`),
    new ButtonBuilder()
      .setLabel('🌐 DRM Steam Run')
      .setStyle(ButtonStyle.Link)
      .setURL(drmUrl),
    new ButtonBuilder()
      .setLabel('🛡️ Download WUB')
      .setStyle(ButtonStyle.Link)
      .setURL('https://www.sordum.org/9470/'),
  );

  // Split into multiple messages to stay under Discord's 6000-char embed limit
  await interaction.reply({ embeds: [welcomeEmbed, guideEmbed] });
  await interaction.channel.send({ embeds: [toolsEmbed, tierEmbed] });
  await interaction.channel.send({ embeds: [preorderEmbed, cmdEmbed] });
  await interaction.channel.send({ embeds: [rulesEmbed, faqEmbed], components: [row1] });
}
