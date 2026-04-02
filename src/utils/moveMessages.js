const { getOrCreateWebhook } = require('./webhook');

const DELAY_MS = 350; // delay between sends to respect rate limits
const REACTION_DELAY_MS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the webhook send payload for a single message.
 */
function buildPayload(message, threadId) {
  // Pass through non-gifv embeds unchanged.
  const embeds = message.embeds.filter((e) => e.data.type !== 'gifv');
  const files = message.attachments.map((a) => a.url);

  return {
    content: message.content || undefined,
    username: message.member?.displayName ?? message.author.username,
    avatarURL: message.author.displayAvatarURL({ extension: 'png', size: 256 }),
    embeds: embeds.length ? embeds : undefined,
    files: files.length ? files : undefined,
    allowedMentions: { parse: [] },
    threadId,
  };
}

/**
 * Add reactions from the original message onto a newly sent message.
 * The bot reacts with each emoji so they appear as real reaction bubbles.
 * Custom emojis from other servers may fail silently.
 *
 * @param {Message} sentMsg - The message that was just sent (fetched from channel)
 * @param {import('discord.js').Message} originalMessage - The original message with reactions
 */
async function copyReactions(sentMsg, originalMessage) {
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
 *
 * @param {import('discord.js').Message[]} messages
 * @param {import('discord.js').TextChannel|import('discord.js').ThreadChannel} destChannel
 * @param {boolean} deleteOriginals
 * @returns {Promise<{ moved: number, failed: number }>}
 */
async function moveMessages(messages, destChannel, deleteOriginals) {
  const { webhook, threadId } = await getOrCreateWebhook(destChannel);
  let moved = 0;
  let failed = 0;

  for (const message of messages) {
    if (message.system) continue;

    try {
      const payload = buildPayload(message, threadId);
      const sentMsg = await webhook.send(payload);
      moved++;

      // Add reactions as actual reaction bubbles if the original had any.
      if (message.reactions.cache.size > 0) {
        try {
          const fetchedMsg = await destChannel.messages.fetch(sentMsg.id);
          await copyReactions(fetchedMsg, message);
        } catch {
          // Could not fetch sent message to copy reactions — skip.
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
        // Best-effort deletion; missing permissions or already deleted is fine.
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

module.exports = { moveMessages, fetchMessagesFrom, fetchAllThreadMessages };
