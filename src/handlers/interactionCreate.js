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
const { moveMessages, fetchMessagesFrom, fetchAllThreadMessages } = require('../utils/moveMessages');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ephemeral(content) {
  return { content, ephemeral: true };
}

function channelSelectRow(sessionId) {
  return new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(`move_dest:${sessionId}`)
      .setPlaceholder('Select destination channel or thread')
      .addChannelTypes(
        ChannelType.GuildText,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.GuildAnnouncement,
        ChannelType.AnnouncementThread
      )
  );
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

function hasManageMessages(member, channel) {
  return member.permissionsIn(channel).has(PermissionFlagsBits.ManageMessages);
}

// ─── Context-menu handlers ────────────────────────────────────────────────────

async function handleMoveThis(interaction) {
  const message = interaction.targetMessage;

  if (!hasManageMessages(interaction.member, interaction.channel)) {
    return interaction.reply(ephemeral('You need the **Manage Messages** permission to move messages.'));
  }

  const sessionId = createSession({
    type: 'moveThis',
    sourceChannelId: interaction.channelId,
    messageId: message.id,
    initiatorId: interaction.user.id,
  });

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Move this message')
        .setDescription(`**Message:** ${message.content?.slice(0, 100) || '*(no text)*'}\n**Author:** ${message.author.toString()}\n\nWhere do you want to move it?`),
    ],
    components: [channelSelectRow(sessionId)],
    ephemeral: true,
  });
}

async function handleMoveThisAndBelow(interaction) {
  const message = interaction.targetMessage;

  if (!hasManageMessages(interaction.member, interaction.channel)) {
    return interaction.reply(ephemeral('You need the **Manage Messages** permission to move messages.'));
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
        .setTitle('Move this message & below')
        .setDescription(
          `Starting from the selected message, up to **100 messages** will be moved.\n\n**First message:** ${message.content?.slice(0, 100) || '*(no text)*'}\n**Author:** ${message.author.toString()}\n\nWhere do you want to move them?`
        ),
    ],
    components: [channelSelectRow(sessionId)],
    ephemeral: true,
  });
}

async function handleMoveThread(interaction) {
  const channel = interaction.channel;

  if (!channel.isThread()) {
    return interaction.reply(
      ephemeral('This action only works inside a **thread** or **forum post**. Right-click a message inside the thread you want to move.')
    );
  }

  if (!hasManageMessages(interaction.member, channel)) {
    return interaction.reply(ephemeral('You need the **Manage Messages** permission to move threads.'));
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
          `All messages from **#${channel.name}** will be moved to a new thread in the destination channel.\n\nWhere do you want to move this thread?`
        ),
    ],
    components: [channelSelectRow(sessionId)],
    ephemeral: true,
  });
}

// ─── Channel-select handler ───────────────────────────────────────────────────

async function handleDestSelect(interaction, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    return interaction.update(ephemeral('This action has expired. Please try again.'));
  }

  const destChannelId = interaction.values[0];

  if (destChannelId === session.sourceChannelId) {
    return interaction.update({
      content: 'The destination must be different from the source channel.',
      components: [channelSelectRow(sessionId)],
      embeds: [],
      ephemeral: true,
    });
  }

  updateSession(sessionId, { destChannelId });

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Delete original messages?')
        .setDescription(`Messages will be copied to <#${destChannelId}>.\nShould the original messages be deleted after moving?`),
    ],
    components: [confirmRow(sessionId)],
    ephemeral: true,
  });
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
        .setDescription('Please wait while messages are being moved.'),
    ],
    components: [],
    ephemeral: true,
  });

  const guild = interaction.guild;
  const destChannel = await guild.channels.fetch(session.destChannelId).catch(() => null);

  if (!destChannel) {
    return interaction.editReply(ephemeral('Could not find the destination channel.'));
  }

  try {
    let messages;
    let resultTitle;

    if (session.type === 'moveThis') {
      const sourceChannel = await guild.channels.fetch(session.sourceChannelId);
      const msg = await sourceChannel.messages.fetch(session.messageId);
      messages = [msg];
      resultTitle = 'Message moved';
    } else if (session.type === 'moveThisAndBelow') {
      const sourceChannel = await guild.channels.fetch(session.sourceChannelId);
      messages = await fetchMessagesFrom(sourceChannel, session.messageId, 100);
      resultTitle = `${messages.length} message(s) moved`;
    } else if (session.type === 'moveThread') {
      const thread = await guild.channels.fetch(session.sourceChannelId);
      messages = await fetchAllThreadMessages(thread);

      // If destination is already a thread, send directly into it.
      // Otherwise create a new thread inside the destination text channel.
      let targetChannel;
      if (destChannel.isThread()) {
        targetChannel = destChannel;
      } else if (destChannel.threads) {
        targetChannel = await destChannel.threads.create({
          name: thread.name,
          reason: `Moved from #${thread.name} by ${interaction.user.tag}`,
        });
      } else {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xed4245)
              .setTitle('Move failed')
              .setDescription('The destination channel does not support threads. Please select a text channel or an existing thread.'),
          ],
          ephemeral: true,
        });
      }

      const { moved, failed } = await moveMessages(messages, targetChannel, deleteOriginals);

      if (deleteOriginals) {
        try { await thread.delete(); } catch { /* ignore */ }
      }

      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle('Thread moved')
            .setDescription(
              `Moved **${moved}** message(s) to <#${targetChannel.id}>${failed ? `, **${failed}** failed` : ''}.`
            ),
        ],
        ephemeral: true,
      });
    }

    const { moved, failed } = await moveMessages(messages, destChannel, deleteOriginals);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle(resultTitle)
          .setDescription(
            `Moved **${moved}** message(s) to <#${destChannel.id}>${failed ? `, **${failed}** failed` : ''}.`
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

    if (interaction.isChannelSelectMenu()) {
      const [action, sessionId] = interaction.customId.split(':');
      if (action === 'move_dest') return handleDestSelect(interaction, sessionId);
    }

    if (interaction.isButton()) {
      const [action, sessionId] = interaction.customId.split(':');
      if (action === 'move_yes') return handleConfirm(interaction, true, sessionId);
      if (action === 'move_no') return handleConfirm(interaction, false, sessionId);
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
