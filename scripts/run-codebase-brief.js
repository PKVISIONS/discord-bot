#!/usr/bin/env node
/**
 * Generate and optionally publish the daily codebase brief immediately.
 *
 * Usage:
 *   node scripts/run-codebase-brief.js
 *   node scripts/run-codebase-brief.js --publish
 */

require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const { runDailyCodebaseBrief } = require('../lib/codebase-brief');
const { publishDailyCodebaseBrief } = require('../lib/codebase-brief-scheduler');

async function main() {
  const publish = process.argv.includes('--publish');
  const brief = await runDailyCodebaseBrief();

  if (!publish) {
    console.log(brief.markdown);
    console.error(`\n[ok] ${brief.filename} (${brief.commitCount} commits) — dry run, not posted`);
    return;
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN is required for --publish');

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(token);
  await new Promise((resolve) => client.once('ready', resolve));

  await publishDailyCodebaseBrief(client, { force: true, onLog: console.log });
  await client.destroy();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
