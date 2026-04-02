const { EmbedBuilder, ChannelType } = require('discord.js');
const { getOrCreateWebhook } = require('./webhook');

const DELAY_MS = 350; // delay between sends to respect rate limits

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format a message's reactions as a compact string, e.g. "👍 3  ❤️ 1"
 */
function formatReactions(message) {
  if (message.reactions.cache.size === 0) return null;
  return message.reactions.cache
    .map((r) => `${r.emoji.toString()} ${r.count}`)
    .join('  ');
}

/**
 * Build the list of payload options for a single message.
 */
function buildPayload(message, threadId) {
  const reactionsText = formatReactions(message);

  // Pass through non-gifv embeds unchanged.
  const embeds = message.embeds.filter((e) => e.data.type !== 'gifv');

  if (reactionsText) {
    embeds.push(
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setFooter({ text: `Reactions: ${reactionsText}` })
        .toJSON()
    );
  }

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
 * Move an array of messages (sorted oldest → newest) to destChannel.
 *
 * @param {Message[]} messages
 * @param {TextChannel|ThreadChannel} destChannel
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
      await webhook.send(payload);
      moved++;
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
 *
 * @param {TextChannel|ThreadChannel} channel
 * @param {string} startMessageId
 * @param {number} limit
 * @returns {Promise<Message[]>}
 */
async function fetchMessagesFrom(channel, startMessageId, limit = 100) {
  const startMessage = await channel.messages.fetch(startMessageId);

  // Fetch messages that came AFTER the start message (newer ones).
  const after = await channel.messages.fetch({
    after: startMessageId,
    limit: Math.min(limit - 1, 99),
  });

  // Combine start message with subsequent messages, sort oldest → newest.
  const all = [startMessage, ...after.values()];
  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return all;
}

/**
 * Fetch all messages in a thread, sorted oldest → newest.
 *
 * @param {ThreadChannel} thread
 * @returns {Promise<Message[]>}
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
