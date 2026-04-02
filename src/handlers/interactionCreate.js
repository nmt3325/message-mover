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
const { moveMessages, fetchMessagesFrom, fetchAllThreadMessages, createForumPostViaWebhook } = require('../utils/moveMessages');

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
}

async function handleMoveThisAndBelow(interaction) {
  const message = interaction.targetMessage;

  if (!hasManageMessages(interaction.member, interaction.channel)) {
    return interaction.reply({ content: 'You need the **Manage Messages** permission to move messages.', ephemeral: true });
  }

  const sessionId = createSession({
    type: 'moveThisAndBelow',
    sourceChannelId: interaction.channelId,
    messageId: message.id,
    initiatorId: interaction.user.id,
  });

  await interaction.reply({
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
  });
}

async function handleMoveThread(interaction) {
  const channel = interaction.channel;

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
}

// ─── Sub-action button handler ────────────────────────────────────────────────

async function handleSubAction(interaction, subAction, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    return interaction.update({ content: 'This action has expired. Please try again.', components: [], embeds: [], ephemeral: true });
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
    ephemeral: true,
  });
}

// ─── Channel-select handler ───────────────────────────────────────────────────

async function handleDestSelect(interaction, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    return interaction.update({ content: 'This action has expired. Please try again.', components: [], embeds: [], ephemeral: true });
  }

  const destChannelId = interaction.values[0];

  if (destChannelId === session.sourceChannelId) {
    return interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setDescription('The destination must be different from the source channel.'),
      ],
      components: [channelSelectRow(sessionId, session.subAction)],
      ephemeral: true,
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
    ephemeral: true,
  });
}

// ─── Execute move ─────────────────────────────────────────────────────────────

async function executeMove(interaction, session, deleteOriginals) {
  const guild = interaction.guild;
  const destChannel = await guild.channels.fetch(session.destChannelId).catch(() => null);
  if (!destChannel) throw new Error('Could not find the destination channel.');

  const subAction = session.subAction;

  // ── moveThis ──────────────────────────────────────────────────────────────
  if (session.type === 'moveThis') {
    const sourceChannel = await guild.channels.fetch(session.sourceChannelId);
    const msg = await sourceChannel.messages.fetch(session.messageId);
    const { moved, failed } = await moveMessages([msg], destChannel, deleteOriginals);
    return { moved, failed, targetId: destChannel.id, title: 'Message moved' };
  }

  // ── moveThisAndBelow ──────────────────────────────────────────────────────
  if (session.type === 'moveThisAndBelow') {
    const sourceChannel = await guild.channels.fetch(session.sourceChannelId);
    const messages = await fetchMessagesFrom(sourceChannel, session.messageId, 100);

    if (messages.length === 0) {
      throw new Error(
        'No messages could be fetched. Make sure the bot has **Read Message History** and **View Channel** permissions in the source channel.'
      );
    }

    let target;
    if (subAction === 'as_thread') {
      target = await destChannel.threads.create({
        name: `Moved from #${sourceChannel.name}`,
        reason: `Moved by ${interaction.user.tag}`,
      });
    } else if (subAction === 'as_forum' || subAction === 'into_forum') {
      // Use webhook to create the forum post so the first message keeps the original author.
      target = await createForumPostViaWebhook(destChannel, messages.shift(), `Moved from #${sourceChannel.name}`);
    } else {
      target = destChannel; // into_channel or into_existing
    }

    const { moved, failed } = await moveMessages(messages, target, deleteOriginals);
    return { moved, failed, targetId: target.id, title: `${moved} message(s) moved` };
  }

  // ── moveThread ────────────────────────────────────────────────────────────
  if (session.type === 'moveThread') {
    const thread = await guild.channels.fetch(session.sourceChannelId);
    const messages = await fetchAllThreadMessages(thread);

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
    } else if (subAction === 'into_forum') {
      // Use webhook to create the forum post so the first message keeps the original author.
      target = await createForumPostViaWebhook(destChannel, messages.shift(), thread.name);
    } else {
      // flatten_channel or flatten_existing → send directly to destChannel
      target = destChannel;
    }

    const { moved, failed } = await moveMessages(messages, target, deleteOriginals);

    if (deleteOriginals) {
      try { await thread.delete(); } catch { /* ignore */ }
    }

    return { moved, failed, targetId: target.id, title: 'Thread moved' };
  }

  throw new Error('Unknown session type: ' + session.type);
}

// ─── Confirmation-button handler ──────────────────────────────────────────────

async function handleConfirm(interaction, deleteOriginals, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    return interaction.update({ content: 'This action has expired. Please try again.', components: [], embeds: [], ephemeral: true });
  }

  deleteSession(sessionId);

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle('Moving messages…')
        .setDescription('Please wait.'),
    ],
    components: [],
    ephemeral: true,
  });

  try {
    const { moved, failed, targetId, title } = await executeMove(interaction, session, deleteOriginals);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle(title)
          .setDescription(
            `Moved **${moved}** message(s) to <#${targetId}>${failed ? `, **${failed}** failed` : ''}.`
          ),
      ],
      ephemeral: true,
    });
  } catch (err) {
    console.error('Move failed:', err);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle('Move failed')
          .setDescription(`An error occurred: ${err.message}`),
      ],
      ephemeral: true,
    });
  }
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

module.exports = async function handleInteraction(interaction) {
  try {
    if (interaction.isMessageContextMenuCommand()) {
      if (interaction.commandName === 'Move this') return handleMoveThis(interaction);
      if (interaction.commandName === 'Move this & below') return handleMoveThisAndBelow(interaction);
      if (interaction.commandName === 'Move thread / forum') return handleMoveThread(interaction);
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
    console.error('Unhandled interaction error:', err);
    const reply = { content: 'An unexpected error occurred.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
};
