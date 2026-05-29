const { EmbedBuilder, MessageFlags } = require('discord.js');
const { getOrCreateWebhook } = require('./webhook');

const DELAY_MS = 350;
const REACTION_DELAY_MS = 300;

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}
function logError(...args) {
  console.error(`[${new Date().toISOString()}]`, ...args);
}

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

  const guild = message.guild;
  const lines = [];
  for (const [, reaction] of message.reactions.cache) {
    let names;
    try {
      const users = await reaction.users.fetch();
      if (guild) {
        const userIds = [...users.keys()];
        let memberMap;
        try {
          const fetched = await guild.members.fetch({ user: userIds });
          memberMap = fetched instanceof Map ? fetched : new Map(fetched);
        } catch {
          memberMap = new Map();
        }
        names = users
          .map((u) => memberMap.get(u.id)?.displayName ?? u.globalName ?? u.username)
          .join(', ');
      } else {
        names = users.map((u) => u.globalName ?? u.username).join(', ');
      }
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
 * freshMember, if provided, is a recently-fetched GuildMember whose nickname
 * is guaranteed to be current (avoids stale cache returning the global display name).
 */
function buildPayload(message, threadId, reactionEmbed, freshMember) {
  const embeds = message.embeds.filter((e) => e.data.type !== 'gifv');
  if (reactionEmbed) embeds.push(reactionEmbed);
  const files = message.attachments.map((a) => a.url);

  const member = freshMember ?? message.member;
  const username = member?.displayName ?? message.author.globalName ?? message.author.username;

  const unixSec = Math.floor(message.createdTimestamp / 1000);
  const timestampLine = `-# 元の送信日時: <t:${unixSec}:f>`;
  const content = message.content ? `${timestampLine}\n${message.content}` : timestampLine;

  return {
    content,
    username,
    avatarURL: message.author.displayAvatarURL({ extension: 'png', size: 256 }),
    embeds: embeds.length ? embeds : undefined,
    files: files.length ? files : undefined,
    allowedMentions: { parse: [] },
    flags: MessageFlags.SuppressNotifications,
    threadId,
  };
}

/**
 * Fetch fresh GuildMember data for all unique authors in the messages array.
 * Returns a Map<userId, GuildMember>.
 */
async function fetchMemberMap(messages) {
  const guild = messages.find((m) => !m.system && m.guild)?.guild;
  if (!guild) return new Map();

  const authorIds = [...new Set(messages.filter((m) => !m.system).map((m) => m.author.id))];
  try {
    const fetched = await guild.members.fetch({ user: authorIds });
    return fetched instanceof Map ? fetched : new Map(fetched);
  } catch {
    return new Map();
  }
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
  const startTime = Date.now();
  log(`[moveMessages] start: total=${messages.length} dest=${destChannel.id} deleteOriginals=${deleteOriginals}`);

  const { webhook, threadId } = await getOrCreateWebhook(destChannel);
  const memberMap = await fetchMemberMap(messages);
  let moved = 0;
  let failed = 0;
  let index = 0;

  for (const message of messages) {
    index++;
    if (message.system) {
      log(`[moveMessages] [${index}/${messages.length}] skipping system message ${message.id}`);
      continue;
    }

    log(`[moveMessages] [${index}/${messages.length}] sending message ${message.id} (reactions=${message.reactions.cache.size})`);
    try {
      const reactionEmbed = await buildReactionEmbed(message);
      const payload = buildPayload(message, threadId, reactionEmbed, memberMap.get(message.author.id));
      const sentMsg = await webhook.send(payload);
      moved++;
      log(`[moveMessages] [${index}/${messages.length}] sent OK → ${sentMsg.id}`);

      // Also add real reaction bubbles so the emojis appear clickable.
      if (message.reactions.cache.size > 0) {
        try {
          const fetchedMsg = await destChannel.messages.fetch(sentMsg.id);
          log(`[moveMessages] [${index}/${messages.length}] copying ${message.reactions.cache.size} reaction(s)`);
          await copyReactionBubbles(fetchedMsg, message);
        } catch (err) {
          log(`[moveMessages] [${index}/${messages.length}] reaction copy failed: ${err.message}`);
        }
      }
    } catch (err) {
      logError(`[moveMessages] [${index}/${messages.length}] send failed for ${message.id}:`, err.message);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  log(`[moveMessages] send phase done: moved=${moved} failed=${failed} elapsed=${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  if (deleteOriginals && messages.length > 0) {
    const sourceChannel = messages[0].channel;
    log(`[moveMessages] delete phase: attempting bulkDelete of ${messages.length} messages in ${sourceChannel.id}`);
    const deleted = await sourceChannel.bulkDelete(messages, true).catch((err) => {
      logError(`[moveMessages] bulkDelete failed: ${err.message}`);
      return null;
    });
    if (deleted) {
      log(`[moveMessages] bulkDelete deleted ${deleted.size} message(s)`);
    }
    // bulkDelete(filterOld=true) skips messages older than 14 days; delete those individually.
    const skippedIds = deleted
      ? new Set(messages.map((m) => m.id).filter((id) => !deleted.has(id)))
      : new Set(messages.map((m) => m.id));
    if (skippedIds.size > 0) {
      log(`[moveMessages] individually deleting ${skippedIds.size} message(s) skipped by bulkDelete`);
      for (const message of messages) {
        if (!skippedIds.has(message.id)) continue;
        try {
          await message.delete();
          log(`[moveMessages] individually deleted ${message.id}`);
        } catch (err) {
          log(`[moveMessages] individual delete failed for ${message.id}: ${err.message}`);
        }
        await sleep(DELAY_MS);
      }
    }
    log(`[moveMessages] delete phase done, elapsed=${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  }

  log(`[moveMessages] complete: moved=${moved} failed=${failed} total elapsed=${((Date.now() - startTime) / 1000).toFixed(1)}s`);
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
 * Fetch all messages in a regular text channel, sorted oldest → newest.
 */
async function fetchAllChannelMessages(channel) {
  const messages = [];
  let before;

  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    messages.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }

  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  log(`[fetchAllChannelMessages] fetched ${messages.length} messages from channel ${channel.id}`);
  return messages;
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

  const memberMap = await fetchMemberMap([firstMessage]);
  const reactionEmbed = await buildReactionEmbed(firstMessage);
  const payload = buildPayload(firstMessage, undefined, reactionEmbed, memberMap.get(firstMessage.author.id));
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

module.exports = { moveMessages, fetchMessagesFrom, fetchAllChannelMessages, fetchAllThreadMessages, createForumPostViaWebhook };
