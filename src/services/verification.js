import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { config } from '../config.js';

/**
 * Verification quiz questions.
 * 3 random questions are picked per user.
 */
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
];

// Active verification sessions: Map<userId, { questions, currentIndex, score, channelId, guildId }>
const sessions = new Map();

/**
 * Pick N random questions from the pool.
 */
function pickQuestions(count = 3) {
  const shuffled = [...QUESTIONS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

/**
 * Handle a bot mention in the verification channel.
 * Called from the message handler when a user @mentions the bot
 * in the configured verification channel.
 */
export async function startVerificationInChannel(message) {
  const userId = message.author.id;
  const member = message.member;

  // Already verified — has verified role
  if (config.verifiedRoleId && member?.roles?.cache?.has(config.verifiedRoleId)) {
    const reply = await message.reply({ content: '✅ You\'re already verified!' });
    setTimeout(() => reply.delete().catch(() => {}), 5000);
    return;
  }

  // Already has an active session
  if (sessions.has(userId)) {
    const reply = await message.reply({ content: '⏳ You already have an active verification quiz! Answer the questions above.' });
    setTimeout(() => reply.delete().catch(() => {}), 5000);
    return;
  }

  const questions = pickQuestions(3);
  sessions.set(userId, {
    questions,
    currentIndex: 0,
    score: 0,
    channelId: message.channel.id,
    guildId: message.guild.id,
  });

  const welcomeEmbed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔐 Verification Quiz')
    .setDescription([
      `Hey <@${userId}>! Let's get you verified.`,
      '',
      'Answer the following **3 questions** correctly to gain access to the server.',
      'The questions are about our rules and how the service works.',
      '',
      '> Read the information channel if you\'re unsure about any answer!',
    ].join('\n'))
    .setFooter({ text: 'Use the dropdown below each question to answer' })
    .setTimestamp();

  await message.channel.send({ content: `<@${userId}>`, embeds: [welcomeEmbed] });
  await sendQuestion(message.channel, userId);
}

/**
 * Send the current question to the verification channel.
 */
async function sendQuestion(channel, userId) {
  const session = sessions.get(userId);
  if (!session) return;

  const q = session.questions[session.currentIndex];
  const questionNum = session.currentIndex + 1;
  const total = session.questions.length;

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`Question ${questionNum}/${total}`)
    .setDescription(`<@${userId}>, ${q.question}`)
    .setFooter({ text: 'Select your answer from the dropdown below' });

  // Shuffle the options for display
  const shuffledOptions = [...q.options].sort(() => Math.random() - 0.5);

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`verify_answer:${userId}:${q.id}`)
      .setPlaceholder('Select your answer...')
      .addOptions(shuffledOptions.map((o) => ({ label: o.label, value: o.value })))
  );

  await channel.send({ embeds: [embed], components: [row] });
}

/**
 * Handle a verification answer from the dropdown.
 * @returns {boolean} true if handled
 */
export async function handleVerifyAnswer(interaction) {
  if (!interaction.isStringSelectMenu()) return false;
  if (!interaction.customId.startsWith('verify_answer:')) return false;

  const parts = interaction.customId.split(':');
  const userId = parts[1];
  const questionId = parts[2];

  // Only the quiz taker can answer
  if (interaction.user.id !== userId) {
    await interaction.reply({ content: 'This isn\'t your quiz!', flags: MessageFlags.Ephemeral });
    return true;
  }

  const session = sessions.get(userId);
  if (!session) {
    await interaction.reply({ content: 'No active verification session. Ping me again to start a new one!', flags: MessageFlags.Ephemeral });
    return true;
  }

  const currentQ = session.questions[session.currentIndex];
  if (currentQ.id !== questionId) {
    await interaction.reply({ content: 'This question has expired. Answer the latest one!', flags: MessageFlags.Ephemeral });
    return true;
  }

  const selected = interaction.values[0];
  const isCorrect = selected === currentQ.correct;

  if (isCorrect) {
    session.score++;
  }

  session.currentIndex++;

  // Check if quiz is complete
  if (session.currentIndex >= session.questions.length) {
    const passed = session.score === session.questions.length;

    if (passed) {
      const successEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ Verification Complete!')
        .setDescription([
          `<@${userId}> answered all **${session.questions.length}/${session.questions.length}** questions correctly!`,
          '',
          'Welcome to the server! You now have full access.',
          '',
          '**Quick start:**',
          '• Use the **ticket panel** or `/activate` to request an activation',
          '• Check `/profile` to see your account',
          '• Support us on Ko-fi for priority perks!',
        ].join('\n'))
        .setTimestamp();

      await interaction.update({ embeds: [successEmbed], components: [] });

      // Role swap: remove unverified, add verified
      try {
        const guild = interaction.client.guilds.cache.get(session.guildId);
        if (guild) {
          const member = await guild.members.fetch(userId).catch(() => null);
          if (member) {
            if (config.verifiedRoleId) {
              await member.roles.add(config.verifiedRoleId).catch((e) =>
                console.error(`[Verify] Failed to add verified role to ${userId}:`, e.message)
              );
            }
            if (config.unverifiedRoleId) {
              await member.roles.remove(config.unverifiedRoleId).catch((e) =>
                console.error(`[Verify] Failed to remove unverified role from ${userId}:`, e.message)
              );
            }
            console.log(`[Verify] ${member.user.tag} verified successfully`);
          }
        }
      } catch (e) {
        console.error('[Verify] Role assignment error:', e.message);
      }
    } else {
      const failEmbed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('❌ Verification Failed')
        .setDescription([
          `<@${userId}> got **${session.score}/${session.questions.length}** correct. You need all of them right!`,
          '',
          'Read the info channel and try again!',
        ].join('\n'))
        .setTimestamp();

      const retryRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`verify_retry:${userId}`)
          .setLabel('🔄 Retry Verification')
          .setStyle(ButtonStyle.Primary)
      );

      await interaction.update({ embeds: [failEmbed], components: [retryRow] });
    }

    sessions.delete(userId);
    return true;
  }

  // Show result of current answer & send next question
  const resultEmoji = isCorrect ? '✅' : '❌';
  const resultText = isCorrect
    ? `${resultEmoji} Correct!`
    : `${resultEmoji} Wrong! The correct answer was: **${currentQ.options.find((o) => o.value === currentQ.correct).label}**`;

  const progressEmbed = new EmbedBuilder()
    .setColor(isCorrect ? 0x57f287 : 0xed4245)
    .setDescription(`<@${userId}> — ${resultText}\n\nProgress: **${session.currentIndex}/${session.questions.length}** • Score: **${session.score}/${session.currentIndex}**`);

  await interaction.update({ embeds: [progressEmbed], components: [] });

  // Send next question after a brief moment
  setTimeout(async () => {
    try {
      const channel = await interaction.client.channels.fetch(session.channelId).catch(() => null);
      if (channel) await sendQuestion(channel, userId);
    } catch {}
  }, 1500);

  return true;
}

/**
 * Handle retry button.
 */
export async function handleVerifyRetry(interaction) {
  if (!interaction.isButton()) return false;
  if (!interaction.customId.startsWith('verify_retry:')) return false;

  const userId = interaction.customId.split(':')[1];
  if (interaction.user.id !== userId) {
    await interaction.reply({ content: 'This isn\'t your retry button!', flags: MessageFlags.Ephemeral });
    return true;
  }

  const questions = pickQuestions(3);
  const guildId = interaction.guild?.id || interaction.client.guilds.cache.first()?.id;
  const channelId = interaction.channel?.id || config.verifyChannelId;
  sessions.set(userId, { questions, currentIndex: 0, score: 0, channelId, guildId });

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('🔄 Verification Retry')
    .setDescription(`<@${userId}>, let's try again! **${questions.length} new questions** coming up...`)
    .setTimestamp();

  await interaction.update({ embeds: [embed], components: [] });

  setTimeout(async () => {
    try {
      const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
      if (channel) await sendQuestion(channel, userId);
    } catch {}
  }, 1500);

  return true;
}
