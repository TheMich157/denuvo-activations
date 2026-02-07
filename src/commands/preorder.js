import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} from 'discord.js';
import { config } from '../config.js';
import { requireGuild } from '../utils/guild.js';
import {
  createPreorder,
  setPreorderThread,
  getPreorder,
  getOpenPreorders,
  closePreorder,
  fulfillPreorder,
  getClaimsForPreorder,
} from '../services/preorder.js';

export const data = new SlashCommandBuilder()
  .setName('preorder')
  .setDescription('Manage game preorders (Activator only)')
  .setContexts(0)
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Create a new game preorder')
      .addStringOption((o) => o.setName('game').setDescription('Game name').setRequired(true))
      .addNumberOption((o) => o.setName('price').setDescription('Minimum donation in $ (default: 5)').setRequired(false))
      .addIntegerOption((o) => o.setName('appid').setDescription('Steam App ID (optional)').setRequired(false))
      .addStringOption((o) => o.setName('description').setDescription('Extra details about the preorder').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('View all open preorders')
  )
  .addSubcommand((sub) =>
    sub
      .setName('guide')
      .setDescription('Post a public guide explaining preorders and payment verification')
  )
  .addSubcommand((sub) =>
    sub
      .setName('close')
      .setDescription('Close a preorder')
      .addIntegerOption((o) => o.setName('id').setDescription('Preorder ID').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('fulfill')
      .setDescription('Mark a preorder as fulfilled (game activated for all verified users)')
      .addIntegerOption((o) => o.setName('id').setDescription('Preorder ID').setRequired(true))
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const sub = interaction.options.getSubcommand();

  if (sub === 'create') {
    const gameName = interaction.options.getString('game');
    const price = interaction.options.getNumber('price') ?? config.minDonation;
    const appId = interaction.options.getInteger('appid');
    const description = interaction.options.getString('description');

    if (price < 1) {
      return interaction.reply({ content: 'Minimum price is $1.', flags: MessageFlags.Ephemeral });
    }

    const preorderId = createPreorder(gameName, appId, description, price, interaction.user.id);

    // Create a forum post in the preorder forum channel if configured
    let forumPost = null;
    if (config.preorderChannelId) {
      try {
        const channel = await interaction.client.channels.fetch(config.preorderChannelId);
        if (channel && channel.type === ChannelType.GuildForum) {
          // Build the starter message embed
          const preorderEmbed = new EmbedBuilder()
            .setColor(0xe91e63)
            .setTitle(`🛒 Preorder #${preorderId}: ${gameName}`)
            .setDescription(
              [
                description || `Preorder for **${gameName}** is now open!`,
                '',
                `**💰 Minimum donation:** $${price.toFixed(2)}`,
                `**🔗 Donate:** [Ko-fi](${config.kofiUrl})`,
                '',
                '**How to claim:**',
                `1. Donate at least **$${price.toFixed(2)}** on [Ko-fi](${config.kofiUrl})`,
                `2. Post your tip proof screenshot in <#${config.tipVerifyChannelId || 'tip-verify'}>`,
                `3. Mention preorder **#${preorderId}** in your proof`,
                '4. Bot will auto-verify your payment',
                '5. Once fulfilled, you\'ll receive your activation!',
              ].join('\n')
            )
            .addFields(
              { name: '🎮 Game', value: gameName, inline: true },
              { name: '📋 Status', value: '🟢 Open', inline: true },
              { name: '👤 Created by', value: `<@${interaction.user.id}>`, inline: true },
            )
            .setFooter({ text: `Preorder #${preorderId}` })
            .setTimestamp();

          const donateRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setLabel('Donate on Ko-fi')
              .setStyle(ButtonStyle.Link)
              .setURL(config.kofiUrl)
              .setEmoji('☕'),
            new ButtonBuilder()
              .setCustomId(`preorder_claim:${preorderId}`)
              .setLabel('I\'ve donated — claim spot')
              .setStyle(ButtonStyle.Success)
              .setEmoji('✅'),
          );

          // Create a forum thread (post) with the embed as the starter message
          forumPost = await channel.threads.create({
            name: `Preorder #${preorderId}: ${gameName.slice(0, 90)}`,
            autoArchiveDuration: 10080, // 7 days
            message: {
              embeds: [preorderEmbed],
              components: [donateRow],
            },
          });
          setPreorderThread(preorderId, forumPost.id);
        }
      } catch (err) {
        // Continue even if forum post creation fails
      }
    }

    const replyText = forumPost
      ? `✅ Preorder **#${preorderId}** created for **${gameName}** ($${price.toFixed(2)}). Post: <#${forumPost.id}>`
      : `✅ Preorder **#${preorderId}** created for **${gameName}** ($${price.toFixed(2)}).`;

    return interaction.reply({ content: replyText, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'guide') {
    const openPreorders = getOpenPreorders();
    const preorderList = openPreorders.length > 0
      ? openPreorders.map((p) => {
          const claims = getClaimsForPreorder(p.id);
          const verified = claims.filter((c) => c.verified === 1).length;
          const threadLink = p.thread_id ? ` → <#${p.thread_id}>` : '';
          return `> **#${p.id}** — **${p.game_name}** • $${p.price.toFixed(2)} • ${verified} verified${threadLink}`;
        }).join('\n')
      : '> *No open preorders right now. Check back soon!*';

    const guideEmbed = new EmbedBuilder()
      .setColor(0xe91e63)
      .setTitle('🛒 How Preorders Work')
      .setDescription(
        [
          'Preorders let you request **upcoming or high-demand games** before they\'re available in the regular panel. Here\'s how:',
          '',
          '**━━━━━━━━━━━━━━━━━━━━━━**',
          '',
          '**Step 1 — Find a Preorder**',
          config.preorderChannelId
            ? `Browse the open preorders in <#${config.preorderChannelId}> or see the list below.`
            : 'Check the open preorders list below.',
          '',
          '**Step 2 — Donate on Ko-fi**',
          `Go to **[Ko-fi](${config.kofiUrl})** and donate the required minimum amount (usually **$${config.minDonation}+**).`,
          'Make sure to include your **Discord username** or the **preorder number** in the Ko-fi message.',
          '',
          '**Step 3 — Post Your Proof**',
          config.tipVerifyChannelId
            ? `Head to <#${config.tipVerifyChannelId}> and post a **screenshot** of your Ko-fi receipt.`
            : 'Post a **screenshot** of your Ko-fi receipt in the tip verification channel.',
          'Include the preorder number in your message, e.g.:',
          '```',
          '#5',
          'preorder 5',
          '```',
          '',
          '**Step 4 — Automatic Verification**',
          'The bot will scan your screenshot and **auto-verify** your payment if it detects:',
          '• A Ko-fi/tip/donation receipt',
          '• The correct dollar amount ($5+ or whatever the preorder requires)',
          '',
          'If auto-verification fails, an activator will **manually review** your proof.',
          '',
          '**Step 5 — Get Your Game**',
          'Once enough people join and the preorder is **fulfilled**, you\'ll receive a DM and your activation will be handled!',
          '',
          '**━━━━━━━━━━━━━━━━━━━━━━**',
        ].join('\n')
      )
      .setTimestamp();

    const currentEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📋 Current Open Preorders')
      .setDescription(preorderList)
      .setTimestamp();

    const components = [];
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Donate on Ko-fi')
        .setStyle(ButtonStyle.Link)
        .setURL(config.kofiUrl)
        .setEmoji('☕'),
    );
    components.push(row);

    await interaction.reply({
      embeds: [guideEmbed, currentEmbed],
      components,
    });
    return;
  }

  if (sub === 'list') {
    const preorders = getOpenPreorders();
    if (preorders.length === 0) {
      return interaction.reply({ content: 'No open preorders.', flags: MessageFlags.Ephemeral });
    }

    const lines = preorders.map((p) => {
      const claims = getClaimsForPreorder(p.id);
      const verified = claims.filter((c) => c.verified === 1).length;
      const threadLink = p.thread_id ? ` • <#${p.thread_id}>` : '';
      return `**#${p.id}** — **${p.game_name}** • $${p.price.toFixed(2)} • ${verified}/${claims.length} verified${threadLink}`;
    });

    const embed = new EmbedBuilder()
      .setColor(0xe91e63)
      .setTitle('🛒 Open Preorders')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `${preorders.length} open preorder${preorders.length !== 1 ? 's' : ''}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'close') {
    const id = interaction.options.getInteger('id');
    const preorder = getPreorder(id);
    if (!preorder) return interaction.reply({ content: `Preorder #${id} not found.`, flags: MessageFlags.Ephemeral });
    if (preorder.status !== 'open') return interaction.reply({ content: `Preorder #${id} is already ${preorder.status}.`, flags: MessageFlags.Ephemeral });
    closePreorder(id);
    return interaction.reply({ content: `✅ Preorder **#${id}** (${preorder.game_name}) is now **closed**.`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'fulfill') {
    const id = interaction.options.getInteger('id');
    const preorder = getPreorder(id);
    if (!preorder) return interaction.reply({ content: `Preorder #${id} not found.`, flags: MessageFlags.Ephemeral });
    fulfillPreorder(id);

    // DM all verified users
    const claims = getClaimsForPreorder(id);
    const verifiedClaims = claims.filter((c) => c.verified === 1);
    let dmCount = 0;
    for (const claim of verifiedClaims) {
      try {
        const user = await interaction.client.users.fetch(claim.user_id).catch(() => null);
        if (user) {
          const embed = new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle('🎉 Preorder Fulfilled!')
            .setDescription(`Your preorder for **${preorder.game_name}** has been fulfilled! An activator will handle your activation soon.`)
            .setFooter({ text: `Preorder #${id}` })
            .setTimestamp();
          await user.send({ embeds: [embed] }).catch(() => {});
          dmCount++;
        }
      } catch {}
    }

    return interaction.reply({
      content: `✅ Preorder **#${id}** (${preorder.game_name}) marked as **fulfilled**. Notified **${dmCount}** verified user${dmCount !== 1 ? 's' : ''}.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
