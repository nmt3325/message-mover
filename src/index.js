require('dotenv').config();

const { Client, GatewayIntentBits, Events } = require('discord.js');
const handleInteraction = require('./handlers/interactionCreate');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Ready! Logged in as ${c.user.tag} (${c.user.id})`);
});

client.on(Events.InteractionCreate, handleInteraction);

client.on(Events.Error, (err) => {
  console.error('Discord client error:', err);
});

client.login(process.env.BOT_TOKEN);
