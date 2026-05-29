const {
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

const { createSession, getSession, updateSession, deleteSession } = require('../utils/sessions');
const { moveMessages, fetchMessagesFrom, fetchAllChannelMessages, fetchAllThreadMessages, createForumPostViaWebhook } = require('../utils/moveMessages');

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}
function logError(...args) {
  console.error(`[${new Date().toISOString()}]`, ...args);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hasManageMessages(member, channel) {
  return member.permissionsIn(channel).has(PermissionFlagsBits.ManageMessages);
}

function confirmRow(sessionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`move_yes:${sessionId}`)
      .setLabel('Yes, delete original')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`move_no:${sessionId}`)
      .setLabel('No, keep original')
      .setStyle(ButtonStyle.Secondary)
  );
}

// Channel select filtered by which sub-action was chosen.
// sub-actions that write flat into a text channel → text/announcement
// sub-actions that target a forum              → GuildForum
// sub-actions that target an existing thread   → thread types
function channelSelectRow(sessionId, subAction) {
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(`move_dest:${sessionId}`)
    .setPlaceholder('Select destination');

  if (subAction === 'into_forum' || subAction === 'as_forum') {
    menu.addChannelTypes(ChannelType.GuildForum);
    menu.setPlaceholder('Select forum channel');
  } else if (subAction === 'into_existing' || subAction === 'flatten_existing') {
    menu.addChannelTypes(
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread
    );
    menu.setPlaceholder('Select existing thread or forum post');
  } else {
    // into_channel / as_thread / flatten_channel / moveThis (default)
    menu.addChannelTypes(
      ChannelType.GuildText,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.GuildAnnouncement,
      ChannelType.AnnouncementThread
    );
  }

  return new ActionRowBuilder().addComponents(menu);
}

// Sub-action button row for "Move this & below"
function subActionRowBelow(sessionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sub:into_channel:${sessionId}`)
      .setLabel('Repost into a channel')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`sub:into_existing:${sessionId}`)
      .setLabel('Repost into a thread/forum')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`sub:as_thread:${sessionId}`)
      .setLabel('Repost as a thread')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`sub:as_forum:${sessionId}`)
      .setLabel('Repost as a forum post')
      .setStyle(ButtonStyle.Secondary)
  );
}

// Sub-action button row for "Move thread / forum"
function subActionRowThread(sessionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sub:as_thread:${sessionId}`)
      .setLabel('Repost into channel as thread')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`sub:into_forum:${sessionId}`)
      .setLabel('Repost into a forum')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`sub:flatten_channel:${sessionId}`)
      .setLabel('Flatten into a channel')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`sub:flatten_existing:${sessionId}`)
      .setLabel('Flatten into a thread/forum')
      .setStyle(ButtonStyle.Secondary)
  );
}

// ─── Context-menu handlers ────────────────────────────────────────────────────

async function handleMoveThis(interaction) {
  const message = interaction.targetMessage;
  log(`[moveThis] user=${interaction.user.tag} channel=${interaction.channelId} messageId=${message.id}`);

  if (!hasManageMessages(interaction.member, interaction.channel)) {
    return interaction.reply({ content: 'You need the **Manage Messages** permission to move messages.', ephemeral: true });
  }

  const sessionId = createSession({
    type: 'moveThis',
    subAction: 'into_channel',
    sourceChannelId: interaction.channelId,
    messageId: message.id,
    initiatorId: interaction.user.id,
  });
  log(`[moveThis] session created: ${sessionId}`);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Move this message')
        .setDescription(
          `**Message:** ${message.content?.slice(0, 100) || '*(no text)*'}\n` +
          `**Author:** ${message.author.toString()}\n\n` +
          `Where do you want to move it?`
        ),
    ],
    components: [channelSelectRow(sessionId, 'into_channel')],
    ephemeral: true,
  });
  log(`[moveThis] reply sent, session=${sessionId}`);
}

async function handleMoveThisAndBelow(interaction) {
  const message = interaction.targetMessage;
  log(`[moveThisAndBelow] user=${interaction.user.tag} channel=${interaction.channelId} messageId=${message.id}`);

  if (!hasManageMessages(interaction.member, interaction.channel)) {
    return interaction.reply({ content: 'You need the **Manage Messages** permission to move messages.', ephemeral: true });
  }

  const sessionId = createSession({
    type: 'moveThisAndBelow',
    sourceChannelId: interaction.channelId,
    messageId: message.id,
    initiatorId: interaction.user.id,
  });
  log(`[moveThisAndBelow] session created: ${sessionId}`);

  const response = await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Move this & below')
        .setDescription(
          `Up to **100 messages** starting from the selected message will be moved.\n\n` +
          `**First message:** ${message.content?.slice(0, 100) || '*(no text)*'}\n` +
          `**Author:** ${message.author.toString()}\n\n` +
          `How do you want to repost them?`
        ),
    ],
    components: [subActionRowBelow(sessionId)],
    ephemeral: true,
    withResponse: true,
  });
  const msgFlags = response?.resource?.message?.flags;
  log(`[moveThisAndBelow] reply sent, session=${sessionId}, message flags=${msgFlags} (ephemeral=${!!(msgFlags & 64)})`);
}

async function handleMoveThread(interaction) {
  const channel = interaction.channel;
  log(`[moveThread] user=${interaction.user.tag} channel=${channel.id} isThread=${channel.isThread()}`);

  if (!channel.isThread()) {
    return interaction.reply({
      content: 'This action only works inside a **thread** or **forum post**. Right-click a message inside the thread you want to move.',
      ephemeral: true,
    });
  }

  if (!hasManageMessages(interaction.member, channel)) {
    return interaction.reply({ content: 'You need the **Manage Messages** permission to move threads.', ephemeral: true });
  }

  const sessionId = createSession({
    type: 'moveThread',
    sourceChannelId: channel.id,
    messageId: interaction.targetMessage.id,
    initiatorId: interaction.user.id,
  });
  log(`[moveThread] session created: ${sessionId}`);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Move thread / forum')
        .setDescription(
          `Thread: **#${channel.name}**\n\nHow do you want to move it?`
        ),
    ],
    components: [subActionRowThread(sessionId)],
    ephemeral: true,
  });
  log(`[moveThread] reply sent, session=${sessionId}`);
}

async function handleMoveThisChannel(interaction) {
  const channel = interaction.channel;
  log(`[moveThisChannel] user=${interaction.user.tag} channel=${channel.id} isThread=${channel.isThread()}`);

  if (channel.isThread()) {
    return interaction.reply({
      content: 'This action works in text channels. For threads, use **Move thread / forum** instead.',
      ephemeral: true,
    });
  }

  if (!hasManageMessages(interaction.member, channel)) {
    return interaction.reply({ content: 'You need the **Manage Messages** permission to move channels.', ephemeral: true });
  }

  const sessionId = createSession({
    type: 'moveThisChannel',
    sourceChannelId: channel.id,
    messageId: interaction.targetMessage.id,
    initiatorId: interaction.user.id,
  });
  log(`[moveThisChannel] session created: ${sessionId}`);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Move this channel')
        .setDescription(`Channel: **#${channel.name}**\n\nHow do you want to move it?`),
    ],
    components: [subActionRowThread(sessionId)],
    ephemeral: true,
  });
  log(`[moveThisChannel] reply sent, session=${sessionId}`);
}

// ─── Sub-action button handler ────────────────────────────────────────────────

async function handleSubAction(interaction, subAction, sessionId) {
  log(`[subAction] user=${interaction.user.tag} subAction=${subAction} session=${sessionId}`);
  const session = getSession(sessionId);
  if (!session) {
    log(`[subAction] session not found: ${sessionId}`);
    return interaction.update({ content: 'This action has expired. Please try again.', components: [], embeds: [] });
  }

  updateSession(sessionId, { subAction });

  const labels = {
    into_channel:    'Repost into a channel',
    into_existing:   'Repost into a thread/forum',
    as_thread:       'Repost as a thread',
    as_forum:        'Repost as a forum post',
    into_forum:      'Repost into a forum',
    flatten_channel: 'Flatten into a channel',
    flatten_existing:'Flatten into a thread/forum',
  };

  const destLabel = {
    into_forum:      'Select a **forum channel**',
    as_forum:        'Select a **forum channel**',
    into_existing:   'Select an **existing thread or forum post**',
    flatten_existing:'Select an **existing thread or forum post**',
  }[subAction] || 'Select a **destination channel**';

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(labels[subAction] || 'Move')
        .setDescription(destLabel),
    ],
    components: [channelSelectRow(sessionId, subAction)],
  });
  log(`[subAction] update sent, session=${sessionId} subAction=${subAction}`);
}

// ─── Channel-select handler ───────────────────────────────────────────────────

async function handleDestSelect(interaction, sessionId) {
  log(`[destSelect] user=${interaction.user.tag} session=${sessionId} dest=${interaction.values[0]}`);
  const session = getSession(sessionId);
  if (!session) {
    log(`[destSelect] session not found: ${sessionId}`);
    return interaction.update({ content: 'This action has expired. Please try again.', components: [], embeds: [] });
  }

  const destChannelId = interaction.values[0];

  if (destChannelId === session.sourceChannelId) {
    log(`[destSelect] destination same as source, rejected`);
    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setDescription('The destination must be different from the source channel.'),
      ],
      components: [channelSelectRow(sessionId, session.subAction)],
    });
  }

  updateSession(sessionId, { destChannelId });

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Delete original messages?')
        .setDescription(
          `Messages will be copied to <#${destChannelId}>.\n` +
          `Should the original messages be deleted after moving?`
        ),
    ],
    components: [confirmRow(sessionId)],
  });
  log(`[destSelect] confirm dialog sent, session=${sessionId} dest=${destChannelId}`);
}

// ─── Execute move ─────────────────────────────────────────────────────────────

async function executeMove(interaction, session, deleteOriginals) {
  const guild = interaction.guild;
  log(`[executeMove] type=${session.type} subAction=${session.subAction} deleteOriginals=${deleteOriginals}`);

  const destChannel = await guild.channels.fetch(session.destChannelId).catch(() => null);
  if (!destChannel) throw new Error('Could not find the destination channel.');

  const subAction = session.subAction;

  // ── moveThis ──────────────────────────────────────────────────────────────
  if (session.type === 'moveThis') {
    const sourceChannel = await guild.channels.fetch(session.sourceChannelId);
    const msg = await sourceChannel.messages.fetch(session.messageId);
    log(`[executeMove] moveThis: fetched message ${msg.id}`);
    const { moved, failed } = await moveMessages([msg], destChannel, deleteOriginals);
    return { moved, failed, targetId: destChannel.id, title: 'Message moved' };
  }

  // ── moveThisAndBelow ──────────────────────────────────────────────────────
  if (session.type === 'moveThisAndBelow') {
    const sourceChannel = await guild.channels.fetch(session.sourceChannelId);
    log(`[executeMove] moveThisAndBelow: fetching messages from ${sourceChannel.id} starting at ${session.messageId}`);
    const messages = await fetchMessagesFrom(sourceChannel, session.messageId, 100);
    log(`[executeMove] moveThisAndBelow: fetched ${messages.length} messages`);

    if (messages.length === 0) {
      throw new Error(
        'No messages could be fetched. Make sure the bot has **Read Message History** and **View Channel** permissions in the source channel.'
      );
    }

    let target;
    if (subAction === 'as_thread') {
      log(`[executeMove] creating thread in ${destChannel.id}`);
      target = await destChannel.threads.create({
        name: `Moved from #${sourceChannel.name}`,
        reason: `Moved by ${interaction.user.tag}`,
      });
      log(`[executeMove] thread created: ${target.id}`);
    } else if (subAction === 'as_forum' || subAction === 'into_forum') {
      // Use webhook to create the forum post so the first message keeps the original author.
      log(`[executeMove] creating forum post in ${destChannel.id}`);
      target = await createForumPostViaWebhook(destChannel, messages.shift(), `Moved from #${sourceChannel.name}`);
      log(`[executeMove] forum post created: ${target.id}, remaining messages: ${messages.length}`);
    } else {
      target = destChannel; // into_channel or into_existing
    }

    const { moved, failed } = await moveMessages(messages, target, deleteOriginals);
    return { moved, failed, targetId: target.id, title: `${moved} message(s) moved` };
  }

  // ── moveThread ────────────────────────────────────────────────────────────
  if (session.type === 'moveThread') {
    const thread = await guild.channels.fetch(session.sourceChannelId);
    log(`[executeMove] moveThread: fetching all messages from thread ${thread.id}`);
    const messages = await fetchAllThreadMessages(thread);
    log(`[executeMove] moveThread: fetched ${messages.length} messages`);

    if (messages.length === 0) {
      throw new Error(
        'No messages could be fetched from the thread. Make sure the bot has **Read Message History** and **View Channel** permissions in this thread.'
      );
    }

    let target;
    if (subAction === 'as_thread') {
      target = await destChannel.threads.create({
        name: thread.name,
        reason: `Moved from #${thread.name} by ${interaction.user.tag}`,
      });
      log(`[executeMove] thread created: ${target.id}`);
    } else if (subAction === 'into_forum') {
      // Use webhook to create the forum post so the first message keeps the original author.
      target = await createForumPostViaWebhook(destChannel, messages.shift(), thread.name);
      log(`[executeMove] forum post created: ${target.id}, remaining messages: ${messages.length}`);
    } else {
      // flatten_channel or flatten_existing → send directly to destChannel
      target = destChannel;
    }

    const { moved, failed } = await moveMessages(messages, target, deleteOriginals);

    if (deleteOriginals) {
      log(`[executeMove] deleting source thread ${thread.id}`);
      try { await thread.delete(); } catch (err) { log(`[executeMove] thread delete failed: ${err.message}`); }
    }

    return { moved, failed, targetId: target.id, title: 'Thread moved' };
  }

  // ── moveThisChannel ───────────────────────────────────────────────────────
  if (session.type === 'moveThisChannel') {
    const sourceChannel = await guild.channels.fetch(session.sourceChannelId);
    log(`[executeMove] moveThisChannel: fetching all messages from channel ${sourceChannel.id}`);
    const messages = await fetchAllChannelMessages(sourceChannel);
    log(`[executeMove] moveThisChannel: fetched ${messages.length} messages`);

    if (messages.length === 0) {
      throw new Error(
        'No messages could be fetched from the channel. Make sure the bot has **Read Message History** and **View Channel** permissions.'
      );
    }

    let target;
    if (subAction === 'as_thread') {
      target = await destChannel.threads.create({
        name: sourceChannel.name,
        reason: `Moved from #${sourceChannel.name} by ${interaction.user.tag}`,
      });
      log(`[executeMove] thread created: ${target.id}`);
    } else if (subAction === 'as_forum' || subAction === 'into_forum') {
      target = await createForumPostViaWebhook(destChannel, messages.shift(), sourceChannel.name);
      log(`[executeMove] forum post created: ${target.id}, remaining messages: ${messages.length}`);
    } else {
      // flatten_channel or flatten_existing → send directly to destChannel
      target = destChannel;
    }

    const { moved, failed } = await moveMessages(messages, target, deleteOriginals);
    return { moved, failed, targetId: target.id, title: `Channel moved (${moved} messages)` };
  }

  throw new Error('Unknown session type: ' + session.type);
}

// ─── Confirmation-button handler ──────────────────────────────────────────────

async function handleConfirm(interaction, deleteOriginals, sessionId) {
  log(`[confirm] user=${interaction.user.tag} session=${sessionId} deleteOriginals=${deleteOriginals}`);
  const session = getSession(sessionId);
  if (!session) {
    log(`[confirm] session not found: ${sessionId}`);
    return interaction.update({ content: 'This action has expired. Please try again.', components: [], embeds: [] });
  }

  deleteSession(sessionId);

  log(`[confirm] showing "Moving messages…" for session=${sessionId}`);
  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle('Moving messages…')
        .setDescription('Please wait.'),
    ],
    components: [],
  });
  log(`[confirm] "Moving messages…" update sent`);

  const startTime = Date.now();
  let resultEmbed;
  try {
    const { moved, failed, targetId, title } = await executeMove(interaction, session, deleteOriginals);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`[confirm] executeMove done in ${elapsed}s: moved=${moved} failed=${failed} target=${targetId}`);
    resultEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle(title)
      .setDescription(
        `Moved **${moved}** message(s) to <#${targetId}>${failed ? `, **${failed}** failed` : ''}.`
      );
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logError(`[confirm] executeMove failed after ${elapsed}s:`, err);
    resultEmbed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('Move failed')
      .setDescription(`An error occurred: ${err.message}`);
  }

  log(`[confirm] calling editReply with result`);
  try {
    await interaction.editReply({ embeds: [resultEmbed] });
    log(`[confirm] editReply sent successfully`);
  } catch (err) {
    logError(`[confirm] editReply failed (token may have expired):`, err);
  }
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

module.exports = async function handleInteraction(interaction) {
  try {
    if (interaction.isMessageContextMenuCommand()) {
      if (interaction.commandName === 'Move this') return handleMoveThis(interaction);
      if (interaction.commandName === 'Move this & below') return handleMoveThisAndBelow(interaction);
      if (interaction.commandName === 'Move thread / forum') return handleMoveThread(interaction);
      if (interaction.commandName === 'Move this channel') return handleMoveThisChannel(interaction);
    }

    if (interaction.isButton()) {
      const parts = interaction.customId.split(':');
      // customId format: "prefix:value:sessionId"
      const prefix = parts[0];
      const sessionId = parts[parts.length - 1];

      if (prefix === 'sub') return handleSubAction(interaction, parts[1], sessionId);
      if (prefix === 'move_yes') return handleConfirm(interaction, true, sessionId);
      if (prefix === 'move_no') return handleConfirm(interaction, false, sessionId);
    }

    if (interaction.isChannelSelectMenu()) {
      const [action, sessionId] = interaction.customId.split(':');
      if (action === 'move_dest') return handleDestSelect(interaction, sessionId);
    }
  } catch (err) {
    logError('Unhandled interaction error:', err);
    const reply = { content: 'An unexpected error occurred.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
};
