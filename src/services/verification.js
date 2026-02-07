import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, MessageFlags, Collection } from 'discord.js';
import { config } from '../config.js';
import { loggingConfig } from '../config/logging.js';

/* ══════════════════════════════════════════════════════════════
   Constants
   ══════════════════════════════════════════════════════════════ */

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_DELAY_MS = 10_000;           // delay before cleaning quiz messages
const NEXT_QUESTION_DELAY_MS = 1_500;      // pause between questions
const MANIFEST_CHANNEL = '<#1469623406898184295>';

/* ══════════════════════════════════════════════════════════════
   Quiz Questions Pool
   ══════════════════════════════════════════════════════════════ */

const QUESTIONS = [
  {
    id: 'q_wub',
    question: 'What must be shown in your screenshot alongside the game folder properties?',
    options: [
      { label: 'Task Manager', value: 'wrong_1' },
      { label: 'WUB (Windows Update Blocker) with red shield', value: 'correct' },
      { label: 'Discord app open', value: 'wrong_2' },
      { label: 'Steam store page', value: 'wrong_3' },
    ],
    correct: 'correct',
  },
  {
    id: 'q_share',
    question: 'Are you allowed to share or resell auth codes you receive?',
    options: [
      { label: 'Yes, with friends only', value: 'wrong_1' },
      { label: 'Yes, if I credit the server', value: 'wrong_2' },
      { label: 'No, never — codes are personal', value: 'correct' },
      { label: 'Yes, after 24 hours', value: 'wrong_3' },
    ],
    correct: 'correct',
  },
  {
    id: 'q_warnings',
    question: 'How many warnings result in an automatic blacklist?',
    options: [
      { label: '1 warning', value: 'wrong_1' },
      { label: '2 warnings', value: 'wrong_2' },
      { label: '3 warnings', value: 'correct' },
      { label: '5 warnings', value: 'wrong_3' },
    ],
    correct: 'correct',
  },
  {
    id: 'q_screenshot_time',
    question: 'How long do you have to upload your screenshot after opening a ticket?',
    options: [
      { label: '1 minute', value: 'wrong_1' },
      { label: '5 minutes', value: 'correct' },
      { label: '30 minutes', value: 'wrong_2' },
      { label: 'No time limit', value: 'wrong_3' },
    ],
    correct: 'correct',
  },
  {
    id: 'q_code_expire',
    question: 'How long is an auth code valid after it\'s generated?',
    options: [
      { label: '5 minutes', value: 'wrong_1' },
      { label: '30 minutes', value: 'correct' },
      { label: '24 hours', value: 'wrong_2' },
      { label: 'Forever', value: 'wrong_3' },
    ],
    correct: 'correct',
  },
  {
    id: 'q_ticket_limit',
    question: 'How many activation tickets can you have open at the same time?',
    options: [
      { label: 'As many as I want', value: 'wrong_1' },
      { label: 'Up to 3', value: 'wrong_2' },
      { label: '1 at a time', value: 'correct' },
      { label: '2 at a time', value: 'wrong_3' },
    ],
    correct: 'correct',
  },
  {
    id: 'q_priority',
    question: 'How can you get priority in the activation queue?',
    options: [
      { label: 'Spam tickets', value: 'wrong_1' },
      { label: 'DM an activator directly', value: 'wrong_2' },
      { label: 'Subscribe to a Ko-fi supporter tier', value: 'correct' },
      { label: 'Create multiple accounts', value: 'wrong_3' },
    ],
    correct: 'correct',
  },
  {
    id: 'q_ownership',
    question: 'Do you need to legitimately own the game on Steam?',
    options: [
      { label: 'No, any account works', value: 'wrong_1' },
      { label: 'Yes, you must own the game', value: 'correct' },
      { label: 'Only for preorders', value: 'wrong_2' },
      { label: 'Only for high-tier games', value: 'wrong_3' },
    ],
    correct: 'correct',
  },
  {
    id: 'q_steamtools',
    question: 'Which tool is required for managing Steam manifests and depots?',
    options: [
      { label: 'Steam Achievement Manager', value: 'wrong_1' },
      { label: 'SteamTools', value: 'correct' },
      { label: 'Cheat Engine', value: 'wrong_2' },
      { label: 'Process Hacker', value: 'wrong_3' },
    ],
    correct: 'correct',
  },
  {
    id: 'q_steamtools_req',
    question: 'What must be true before running SteamTools?',
    options: [
      { label: 'Steam must be running', value: 'wrong_1' },
      { label: 'Steam must be closed and SteamTools run as administrator', value: 'correct' },
      { label: 'You need a VPN active', value: 'wrong_2' },
      { label: 'Discord must be closed', value: 'wrong_3' },
    ],
    correct: 'correct',
  },
  {
    id: 'q_manifest',
    question: 'Where can you get manifest files in this server?',
    options: [
      { label: 'DM a staff member', value: 'wrong_1' },
      { label: 'The manifest channel — send a Steam App ID', value: 'correct' },
      { label: 'The general chat', value: 'wrong_2' },
      { label: 'They are not available', value: 'wrong_3' },
    ],
    correct: 'correct',
  },
  {
    id: 'q_manifest_use',
    question: 'What do you send in the manifest channel to get a manifest file?',
    options: [
      { label: 'The game name', value: 'wrong_1' },
      { label: 'A Steam App ID (e.g. 500)', value: 'correct' },
      { label: 'Your Steam username', value: 'wrong_2' },
      { label: 'A download link', value: 'wrong_3' },
    ],
    correct: 'correct',
  },
];

/* ══════════════════════════════════════════════════════════════
   Session Management
   ══════════════════════════════════════════════════════════════ */

// Active sessions: Map<userId, { questions, currentIndex, score, channelId, guildId, messageIds[], timer }>
const sessions = new Map();

function pickQuestions(count = 3) {
  const shuffled = [...QUESTIONS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

/** Build a text-based progress bar. */
function quizProgressBar(current, total) {
  const filled = current;
  const empty = total - current;
  return '▓'.repeat(filled) + '░'.repeat(empty);
}

/** Expire a session and notify the user. */
async function expireSession(client, userId) {
  const session = sessions.get(userId);
  if (!session) return;

  sessions.delete(userId);

  try {
    const channel = await client.channels.fetch(session.channelId).catch(() => null);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle('⏰ Verification Timed Out')
      .setDescription(
        [
          `<@${userId}>, your verification quiz expired after **5 minutes** of inactivity.`,
          '',
          'No worries — just ping me again to start a new quiz!',
        ].join('\n')
      )
      .setFooter({ text: 'Sessions expire after 5 minutes' })
      .setTimestamp();

    const msg = await channel.send({ embeds: [embed] });
    session.messageIds.push(msg.id);

    // Clean up all messages after a delay
    setTimeout(() => {
      cleanupQuizMessages(client, session.channelId, session.messageIds).catch(() => {});
    }, CLEANUP_DELAY_MS);
  } catch {}
}

/** Start (or restart) the session timeout timer. */
function resetSessionTimer(client, userId) {
  const session = sessions.get(userId);
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => expireSession(client, userId), SESSION_TIMEOUT_MS);
}

/* ══════════════════════════════════════════════════════════════
   Logging
   ══════════════════════════════════════════════════════════════ */

async function logVerification(client, { userId, passed, score, total, tag }) {
  if (!loggingConfig.logChannelId) return;
  try {
    const logChannel = await client.channels.fetch(loggingConfig.logChannelId).catch(() => null);
    if (!logChannel?.send) return;
    const embed = new EmbedBuilder()
      .setColor(passed ? 0x57f287 : 0xed4245)
      .setTitle(passed ? '✅ Verification Passed' : '❌ Verification Failed')
      .addFields(
        { name: 'User', value: `<@${userId}> (${tag || userId})`, inline: true },
        { name: 'Score', value: `**${score}/${total}**`, inline: true },
        { name: 'Result', value: passed ? 'Verified — roles updated' : 'Failed — must retry', inline: true },
      )
      .setTimestamp();
    await logChannel.send({ embeds: [embed] });
  } catch {}
}

/* ══════════════════════════════════════════════════════════════
   Message Cleanup
   ══════════════════════════════════════════════════════════════ */

async function cleanupQuizMessages(client, channelId, messageIds) {
  if (!messageIds || messageIds.length === 0) return;
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;
    if (messageIds.length === 1) {
      const msg = await channel.messages.fetch(messageIds[0]).catch(() => null);
      if (msg?.deletable) await msg.delete().catch(() => {});
    } else {
      for (let i = 0; i < messageIds.length; i += 100) {
        const batch = messageIds.slice(i, i + 100);
        await channel.bulkDelete(batch).catch(async () => {
          for (const id of batch) {
            const msg = await channel.messages.fetch(id).catch(() => null);
            if (msg?.deletable) await msg.delete().catch(() => {});
          }
        });
      }
    }
  } catch {}
}

/* ══════════════════════════════════════════════════════════════
   Start Verification
   ══════════════════════════════════════════════════════════════ */

export async function startVerificationInChannel(message) {
  const userId = message.author.id;
  const member = message.member;

  // ── Already verified ──
  if (config.verifiedRoleId && member?.roles?.cache?.has(config.verifiedRoleId)) {
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setDescription(`✅ <@${userId}>, you're already verified! You have full access to the server.`)
      .setTimestamp();
    const reply = await message.reply({ embeds: [embed] });
    setTimeout(() => { reply.delete().catch(() => {}); message.delete().catch(() => {}); }, 5000);
    return;
  }

  // ── Already has an active session ──
  if (sessions.has(userId)) {
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setDescription(`⏳ <@${userId}>, you already have an active quiz! Scroll up and answer the current question.`)
      .setFooter({ text: 'Sessions expire after 5 minutes of inactivity' })
      .setTimestamp();
    const reply = await message.reply({ embeds: [embed] });
    setTimeout(() => { reply.delete().catch(() => {}); message.delete().catch(() => {}); }, 5000);
    return;
  }

  // ── Start new session ──
  const questions = pickQuestions(3);
  const messageIds = [];
  messageIds.push(message.id);

  sessions.set(userId, {
    questions,
    currentIndex: 0,
    score: 0,
    channelId: message.channel.id,
    guildId: message.guild.id,
    messageIds,
    timer: null,
  });

  const kofiUrl = config.kofiUrl || 'https://ko-fi.com/denubrew';
  const total = questions.length;

  const welcomeEmbed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setAuthor({ name: 'DenuBrew Verification', iconURL: message.client.user.displayAvatarURL({ size: 64 }) })
    .setTitle('🔐 Verification Quiz')
    .setDescription(
      [
        `Welcome <@${userId}>! Before you can use the server, you need to pass a quick quiz.`,
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
        '**How it works:**',
        `• Answer all **${total} questions** correctly to get verified`,
        '• Questions are about our rules, tools, and how the service works',
        '• Use the dropdown menu below each question to select your answer',
        `• You have **5 minutes** to complete the quiz — don't take too long!`,
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
        '**What you unlock after verification:**',
        '🎮 **Activation tickets** — Request Denuvo tokens for your Steam games',
        `📦 **Manifest files** — Available in ${MANIFEST_CHANNEL}`,
        `☕ **Ko-fi perks** — Support us at [Ko-fi](${kofiUrl}) for priority access`,
        '🛒 **Preorders** — Reserve spots for upcoming games',
        '',
        '> 📖 **Tip:** Read the info channel if you\'re unsure about any answer!',
      ].join('\n')
    )
    .setFooter({ text: `${total} questions • 5 min time limit • All correct to pass` })
    .setTimestamp();

  const welcomeMsg = await message.channel.send({ content: `<@${userId}>`, embeds: [welcomeEmbed] });
  messageIds.push(welcomeMsg.id);

  resetSessionTimer(message.client, userId);
  await sendQuestion(message.channel, userId);
}

/* ══════════════════════════════════════════════════════════════
   Send Question
   ══════════════════════════════════════════════════════════════ */

async function sendQuestion(channel, userId) {
  const session = sessions.get(userId);
  if (!session) return;

  const q = session.questions[session.currentIndex];
  const questionNum = session.currentIndex + 1;
  const total = session.questions.length;
  const bar = quizProgressBar(session.currentIndex, total);

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`Question ${questionNum} of ${total}`)
    .setDescription(
      [
        `\`${bar}\` ${session.currentIndex}/${total} answered`,
        '',
        `<@${userId}>, **${q.question}**`,
      ].join('\n')
    )
    .setFooter({ text: `Score so far: ${session.score}/${session.currentIndex} correct • Select your answer below` });

  const shuffledOptions = [...q.options].sort(() => Math.random() - 0.5);

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`verify_answer:${userId}:${q.id}`)
      .setPlaceholder(`Question ${questionNum}: Pick your answer...`)
      .addOptions(shuffledOptions.map((o) => ({ label: o.label, value: o.value })))
  );

  const msg = await channel.send({ embeds: [embed], components: [row] });
  session.messageIds.push(msg.id);
}

/* ══════════════════════════════════════════════════════════════
   Handle Answer
   ══════════════════════════════════════════════════════════════ */

export async function handleVerifyAnswer(interaction) {
  if (!interaction.isStringSelectMenu()) return false;
  if (!interaction.customId.startsWith('verify_answer:')) return false;

  const parts = interaction.customId.split(':');
  const userId = parts[1];
  const questionId = parts[2];

  if (interaction.user.id !== userId) {
    await interaction.reply({ content: '❌ This isn\'t your quiz! Ping the bot to start your own.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const session = sessions.get(userId);
  if (!session) {
    await interaction.reply({
      content: '⏰ Your verification session expired. Ping me again to start a new quiz!',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const currentQ = session.questions[session.currentIndex];
  if (currentQ.id !== questionId) {
    await interaction.reply({ content: '⚠️ This question has expired. Answer the latest one above!', flags: MessageFlags.Ephemeral });
    return true;
  }

  // Reset timeout on interaction
  resetSessionTimer(interaction.client, userId);

  const selected = interaction.values[0];
  const isCorrect = selected === currentQ.correct;
  if (isCorrect) session.score++;
  session.currentIndex++;

  const total = session.questions.length;
  const bar = quizProgressBar(session.currentIndex, total);

  // ── Quiz complete? ──
  if (session.currentIndex >= total) {
    const passed = session.score === total;
    const userTag = interaction.user.tag || interaction.user.username;

    // Clear timer
    if (session.timer) clearTimeout(session.timer);

    if (passed) {
      // ── SUCCESS ──
      const kofiUrl = config.kofiUrl || 'https://ko-fi.com/denubrew';

      const successEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setAuthor({ name: 'Verification Complete', iconURL: interaction.user.displayAvatarURL({ size: 64 }) })
        .setTitle('🎉 Welcome to DenuBrew!')
        .setDescription(
          [
            `\`${bar}\` **${session.score}/${total}** — Perfect score!`,
            '',
            `Congratulations <@${userId}>! You've been verified and now have **full access** to the server.`,
            '',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '',
            '**Get started:**',
            '🎮 Use the activation panel or `/activate` to request a Denuvo token',
            `📦 Get manifest files in ${MANIFEST_CHANNEL} — just send a Steam App ID`,
            '🔨 Make sure you have **SteamTools** and **WUB** installed',
            `☕ Support us on **[Ko-fi](${kofiUrl})** for priority queue perks`,
            '',
            '> Enjoy the server and happy gaming!',
          ].join('\n')
        )
        .setThumbnail(interaction.user.displayAvatarURL({ size: 256 }))
        .setFooter({ text: `Verified • ${userTag}` })
        .setTimestamp();

      await interaction.update({ embeds: [successEmbed], components: [] });

      // Role swap: remove unverified, add verified
      try {
        const guild = interaction.client.guilds.cache.get(session.guildId);
        if (guild) {
          const member = await guild.members.fetch(userId).catch(() => null);
          if (member) {
            const roleOps = [];
            if (config.verifiedRoleId) {
              roleOps.push(
                member.roles.add(config.verifiedRoleId).catch((e) =>
                  console.error(`[Verify] Failed to add verified role to ${userId}:`, e.message)
                )
              );
            }
            if (config.unverifiedRoleId) {
              roleOps.push(
                member.roles.remove(config.unverifiedRoleId).catch((e) =>
                  console.error(`[Verify] Failed to remove unverified role from ${userId}:`, e.message)
                )
              );
            }
            await Promise.all(roleOps);
            console.log(`[Verify] ${member.user.tag} verified successfully (${session.score}/${total})`);
          }
        }
      } catch (e) {
        console.error('[Verify] Role assignment error:', e.message);
      }

      logVerification(interaction.client, { userId, passed: true, score: session.score, total, tag: userTag }).catch(() => {});

      // Clean up quiz messages after delay
      const channelId = session.channelId;
      const msgIds = [...session.messageIds];
      if (interaction.message?.id && !msgIds.includes(interaction.message.id)) {
        msgIds.push(interaction.message.id);
      }
      setTimeout(() => {
        cleanupQuizMessages(interaction.client, channelId, msgIds).catch(() => {});
      }, CLEANUP_DELAY_MS);

    } else {
      // ── FAIL ──
      const correctAnswer = isCorrect ? '' : `\nThe correct answer was: **${currentQ.options.find((o) => o.value === currentQ.correct).label}**`;

      const failEmbed = new EmbedBuilder()
        .setColor(0xed4245)
        .setAuthor({ name: 'Verification Failed', iconURL: interaction.user.displayAvatarURL({ size: 64 }) })
        .setTitle('❌ Quiz Not Passed')
        .setDescription(
          [
            `\`${bar}\` **${session.score}/${total}** correct${correctAnswer}`,
            '',
            `<@${userId}>, you need to get **all ${total} questions** right to pass.`,
            '',
            '**Don\'t worry — you can retry right away!**',
            'Read the info channel carefully before trying again. The questions cover:',
            '• Server rules and warning system',
            '• How activations and tickets work',
            '• Required tools (WUB, SteamTools)',
            '• Manifest files and how to get them',
            '',
            '> Hit the retry button below when you\'re ready!',
          ].join('\n')
        )
        .setFooter({ text: `Score: ${session.score}/${total} • You need ${total}/${total} to pass` })
        .setTimestamp();

      const retryRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`verify_retry:${userId}`)
          .setLabel('Retry Quiz')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🔄'),
      );

      await interaction.update({ embeds: [failEmbed], components: [retryRow] });

      logVerification(interaction.client, { userId, passed: false, score: session.score, total, tag: userTag }).catch(() => {});
    }

    sessions.delete(userId);
    return true;
  }

  // ── Not done yet — show answer result and send next question ──
  const resultEmoji = isCorrect ? '✅' : '❌';
  const correctLabel = currentQ.options.find((o) => o.value === currentQ.correct).label;
  const resultText = isCorrect
    ? `${resultEmoji} **Correct!**`
    : `${resultEmoji} **Wrong!** The answer was: **${correctLabel}**`;

  const progressEmbed = new EmbedBuilder()
    .setColor(isCorrect ? 0x57f287 : 0xed4245)
    .setDescription(
      [
        `<@${userId}> — ${resultText}`,
        '',
        `\`${bar}\` **${session.currentIndex}/${total}** answered • Score: **${session.score}/${session.currentIndex}**`,
        '',
        `Next question coming up...`,
      ].join('\n')
    );

  await interaction.update({ embeds: [progressEmbed], components: [] });

  setTimeout(async () => {
    try {
      const channel = await interaction.client.channels.fetch(session.channelId).catch(() => null);
      if (channel) await sendQuestion(channel, userId);
    } catch {}
  }, NEXT_QUESTION_DELAY_MS);

  return true;
}

/* ══════════════════════════════════════════════════════════════
   Retry Handler
   ══════════════════════════════════════════════════════════════ */

export async function handleVerifyRetry(interaction) {
  if (!interaction.isButton()) return false;
  if (!interaction.customId.startsWith('verify_retry:')) return false;

  const userId = interaction.customId.split(':')[1];
  if (interaction.user.id !== userId) {
    await interaction.reply({ content: '❌ This isn\'t your retry button!', flags: MessageFlags.Ephemeral });
    return true;
  }

  const oldMsgId = interaction.message?.id;
  const questions = pickQuestions(3);
  const guildId = interaction.guild?.id || interaction.client.guilds.cache.first()?.id;
  const channelId = interaction.channel?.id || config.verifyChannelId;
  const messageIds = [];
  if (oldMsgId) messageIds.push(oldMsgId);

  sessions.set(userId, {
    questions,
    currentIndex: 0,
    score: 0,
    channelId,
    guildId,
    messageIds,
    timer: null,
  });

  const total = questions.length;

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔄 New Attempt Started')
    .setDescription(
      [
        `<@${userId}>, let's give it another shot!`,
        '',
        `\`${'░'.repeat(total)}\` 0/${total} answered`,
        '',
        `**${total} new questions** are coming up. Remember:`,
        '• Read each question carefully',
        '• You need **all correct** to pass',
        '• Check the info channel if you\'re unsure',
      ].join('\n')
    )
    .setFooter({ text: '5 minute time limit • Good luck!' })
    .setTimestamp();

  await interaction.update({ embeds: [embed], components: [] });

  resetSessionTimer(interaction.client, userId);

  setTimeout(async () => {
    try {
      const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
      if (channel) await sendQuestion(channel, userId);
    } catch {}
  }, NEXT_QUESTION_DELAY_MS);

  return true;
}
