const { REST } = require('@discordjs/rest');
const { Routes, ApplicationCommandType } = require('discord-api-types/v10');
require('dotenv').config();

const commands = [
  {
    name: 'Move this',
    type: ApplicationCommandType.Message,
    default_member_permissions: null,
  },
  {
    name: 'Move this & below',
    type: ApplicationCommandType.Message,
    default_member_permissions: null,
  },
  {
    name: 'Move thread / forum',
    type: ApplicationCommandType.Message,
    default_member_permissions: null,
  },
];

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

(async () => {
  try {
    console.log('Registering application commands...');

    if (process.env.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
      );
      console.log(`Registered ${commands.length} guild commands to guild ${process.env.GUILD_ID}`);
    } else {
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands }
      );
      console.log(`Registered ${commands.length} global commands`);
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
