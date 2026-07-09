#!/usr/bin/env node
/**
 * Re-register slash commands and clear stale global duplicates.
 * Registers commands in every guild the bot is in (plus DISCORD_GUILD_ID / DISCORD_GUILD_IDS).
 * Run: npm run slash:refresh
 */

require('dotenv').config({ override: true });

const { REST, Routes } = require('discord.js');
const { buildSlashCommandsPayload } = require('../lib/slash-commands');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '';
const BOT_USER_ID = process.env.BOT_USER_ID;

if (!DISCORD_TOKEN || !BOT_USER_ID) {
  console.error('Set DISCORD_TOKEN and BOT_USER_ID in .env');
  process.exit(1);
}

const commands = buildSlashCommandsPayload();

function parseExtraGuildIds() {
  const raw = process.env.DISCORD_GUILD_IDS || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function listBotGuildIds(rest) {
  try {
    const guilds = await rest.get(Routes.userGuilds());
    return (guilds || []).map((g) => g.id);
  } catch (error) {
    console.warn('Could not list bot guilds via API:', error.message);
    return [];
  }
}

async function main() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  console.log('Clearing global application commands…');
  await rest.put(Routes.applicationCommands(BOT_USER_ID), { body: [] });

  const fromApi = await listBotGuildIds(rest);
  const guildIds = [...new Set([
    ...fromApi,
    ...parseExtraGuildIds(),
    ...(DISCORD_GUILD_ID ? [DISCORD_GUILD_ID] : []),
  ])];

  if (!guildIds.length) {
    console.error('No guilds found. Invite the bot to a server first, or set DISCORD_GUILD_ID.');
    process.exit(1);
  }

  console.log(`Registering ${commands.length} commands in ${guildIds.length} guild(s)…`);
  for (const guildId of guildIds) {
    await rest.put(Routes.applicationGuildCommands(BOT_USER_ID, guildId), { body: commands });
    console.log(`  ✓ guild ${guildId}`);
  }

  console.log('Done. Restart Discord client (Cmd+R) if slash UI still glitches.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
