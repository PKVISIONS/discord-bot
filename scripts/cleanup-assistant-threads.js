#!/usr/bin/env node
/**
 * Manually delete assistant hub threads older than ASSISTANT_THREAD_MAX_AGE_HOURS.
 *
 * Usage:
 *   npm run threads:cleanup
 *   npm run threads:cleanup -- --dry-run
 */

require('dotenv').config({ override: true });

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { cleanupAssistantHubThreads, cleanupStatus } = require('../lib/assistant-thread-cleanup');

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN is not set.');

  const dryRun = process.argv.includes('--dry-run');
  console.log(`Thread cleanup: ${cleanupStatus()}${dryRun ? ' (dry-run)' : ''}`);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
  });

  await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
    client.login(token);
  });

  try {
    const result = await cleanupAssistantHubThreads(client, { dryRun, onLog: console.log });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    client.destroy();
  }
}

main().catch((error) => {
  console.error('Cleanup failed:', error.message);
  process.exit(1);
});
