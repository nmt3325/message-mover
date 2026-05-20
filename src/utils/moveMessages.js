const { EmbedBuilder, MessageFlags } = require('discord.js');
const { getOrCreateWebhook } = require('./webhook');

const DELAY_MS = 350;
const REACTION_DELAY_MS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch each reaction's users and return an embed like:
 *   👍 Alice, Bob, Carol
 *   ❤️ Dave
 * Returns null if there are no reactions.
 */
async function buildReactionEmbed(message) {
  if (message.reactions.cache.size === 0) return null;

  const lines = [];
  for (const [, reaction] of message.reactions.cache) {
    let names;
    try {
      const users = await reaction.users.fetch();
      names = users.map((u) => u.username).join(', ');
    } catch {
      names = `${reaction.count} user(s)`;
    }
    lines.push(`${reaction.emoji.toString()} ${names}`);
  }

  return new EmbedBuilder()
    .setColor(0x2b2d31)
    .setDescription(lines.join('\n'))
    .toJSON();
}

/**
 * Build the webhook send payload for a single message.
 */
function buildPayload(message, threadId, reactionEmbed) {
  const embeds = message.embeds.filter((e) => e.data.type !== 'gifv');
  if (reactionEmbed) embeds.push(reactionEmbed);
  const files = message.attachments.map((a) => a.url);

  return {
    content: message.content || undefined,
    username: message.member?.displayName ?? message.author.username,
    avatarURL: message.author.displayAvatarURL({ extension: 'png', size: 256 }),
    embeds: embeds.length ? embeds : undefined,
    files: files.length ? files : undefined,
    allowedMentions: { parse: [] },
    flags: MessageFlags.SuppressNotifications,
    threadId,
  };
}

/**
 * React to sentMsg with every emoji from the original message,
 * so reaction bubbles appear under the moved message.
 */
async function copyReactionBubbles(sentMsg, originalMessage) {
  for (const [, reaction] of originalMessage.reactions.cache) {
    try {
      await sentMsg.react(reaction.emoji);
      await sleep(REACTION_DELAY_MS);
    } catch {
      // Custom emoji unavailable in this server, or missing permission — skip.
    }
  }
}

/**
 * Move an array of messages (sorted oldest → newest) to destChannel.
 */
async function moveMessages(messages, destChannel, deleteOriginals) {
  const { webhook, threadId } = await getOrCreateWebhook(destChannel);
  let moved = 0;
  let failed = 0;

  for (const message of messages) {
    if (message.system) continue;

    try {
      const reactionEmbed = await buildReactionEmbed(message);
      const payload = buildPayload(message, threadId, reactionEmbed);
      const sentMsg = await webhook.send(payload);
      moved++;

      // Also add real reaction bubbles so the emojis appear clickable.
      if (message.reactions.cache.size > 0) {
        try {
          const fetchedMsg = await destChannel.messages.fetch(sentMsg.id);
          await copyReactionBubbles(fetchedMsg, message);
        } catch {
          // Could not fetch sent message — skip reaction bubbles.
        }
      }
    } catch (err) {
      console.error(`Failed to send message ${message.id}:`, err.message);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  if (deleteOriginals) {
    for (const message of messages) {
      try {
        await message.delete();
      } catch {
        // Best-effort; ignore missing permissions or already-deleted messages.
      }
      await sleep(DELAY_MS);
    }
  }

  return { moved, failed };
}

/**
 * Fetch up to `limit` messages from a channel starting at (and including) startMessageId.
 * Returns them sorted oldest → newest.
 */
async function fetchMessagesFrom(channel, startMessageId, limit = 100) {
  const startMessage = await channel.messages.fetch(startMessageId);

  const after = await channel.messages.fetch({
    after: startMessageId,
    limit: Math.min(limit - 1, 99),
  });

  const all = [startMessage, ...after.values()];
  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return all;
}

/**
 * Fetch all messages in a thread, sorted oldest → newest.
 */
async function fetchAllThreadMessages(thread) {
  const messages = [];
  let before;

  while (true) {
    const batch = await thread.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    messages.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }

  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return messages;
}

/**
 * Create a new forum post via webhook, preserving the original author's
 * name and avatar for the first message (the post body).
 *
 * Uses the webhook `threadName` option instead of threads.create(),
 * which would send the first message as the bot.
 *
 * @param {ForumChannel} forumChannel
 * @param {Message} firstMessage - becomes the forum post body
 * @param {string} postName - title of the new forum post
 * @returns {Promise<ThreadChannel>} the newly created forum post (thread)
 */
async function createForumPostViaWebhook(forumChannel, firstMessage, postName) {
  const { webhook } = await getOrCreateWebhook(forumChannel);

  const reactionEmbed = await buildReactionEmbed(firstMessage);
  const payload = buildPayload(firstMessage, undefined, reactionEmbed);
  // Setting threadName instead of threadId tells Discord to create a new forum post.
  payload.threadName = postName;

  const sentMsg = await webhook.send(payload);
  const newThreadId = sentMsg.channel_id;

  // Fetch the created thread so we can add reactions and return it to the caller.
  const newThread = await forumChannel.guild.channels.fetch(newThreadId);

  if (firstMessage.reactions.cache.size > 0) {
    try {
      const fetchedMsg = await newThread.messages.fetch(sentMsg.id);
      await copyReactionBubbles(fetchedMsg, firstMessage);
    } catch {
      // Skip reactions if fetch fails.
    }
  }

  return newThread;
}

module.exports = { moveMessages, fetchMessagesFrom, fetchAllThreadMessages, createForumPostViaWebhook };
