const { WebhookClient } = require('discord.js');

// Cache webhook clients by parent channel ID to avoid recreating them.
const webhookCache = new Map();

/**
 * Returns a WebhookClient and optional threadId for sending to the given channel.
 * For threads, creates/fetches the webhook on the parent channel.
 *
 * @param {TextChannel|ThreadChannel} channel
 * @returns {Promise<{ webhook: WebhookClient, threadId: string|undefined }>}
 */
async function getOrCreateWebhook(channel) {
  const isThread = channel.isThread();
  const webhookChannel = isThread ? channel.parent : channel;

  if (!webhookChannel) {
    throw new Error('Cannot resolve a webhook channel for: ' + channel.id);
  }

  // Return cached client if available.
  if (webhookCache.has(webhookChannel.id)) {
    return {
      webhook: webhookCache.get(webhookChannel.id),
      threadId: isThread ? channel.id : undefined,
    };
  }

  // Look for an existing webhook we own.
  let existingWebhook = null;
  try {
    const webhooks = await webhookChannel.fetchWebhooks();
    existingWebhook = webhooks.find(
      (wh) => wh.owner?.id === webhookChannel.client.user.id && wh.token
    );
  } catch {
    // Missing MANAGE_WEBHOOKS permission — fall through to create attempt.
  }

  if (!existingWebhook) {
    existingWebhook = await webhookChannel.createWebhook({
      name: 'Message Mover',
      reason: 'Used by Message Mover bot to preserve author identity when moving messages',
    });
  }

  const client = new WebhookClient({ id: existingWebhook.id, token: existingWebhook.token });
  webhookCache.set(webhookChannel.id, client);

  return {
    webhook: client,
    threadId: isThread ? channel.id : undefined,
  };
}

module.exports = { getOrCreateWebhook };
