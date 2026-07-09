#!/usr/bin/env node
/**
 * Backfill raw Discord capture logs from historical messages in the configured
 * KNOWLEDGE_CAPTURE_CHANNELS (and their threads). Optionally auto-promote
 * threads that already look solved.
 *
 * Usage:
 *   node scripts/import-discord-history.js            # log raw history only
 *   node scripts/import-discord-history.js --extract  # also promote solved threads
 *
 * Env:
 *   KB_IMPORT_LIMIT   max messages fetched per channel/thread (default 500)
 */

require('dotenv').config({ override: true });

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const {
  getCaptureChannels,
  appendMessageToLog,
} = require('../lib/discord-capture-log');
const { promote, isSolveEmoji } = require('../lib/knowledge-promotion');

const IMPORT_LIMIT = Number(process.env.KB_IMPORT_LIMIT || 500);
const DO_EXTRACT = process.argv.includes('--extract');

async function fetchAllMessages(channel, limit) {
  const collected = [];
  let before;
  while (collected.length < limit) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || !batch.size) break;
    const arr = Array.from(batch.values());
    collected.push(...arr);
    before = arr[arr.length - 1].id;
    if (batch.size < 100) break;
  }
  return collected;
}

function looksSolved(messages) {
  return messages.some((m) => {
    const reacted = m.reactions?.cache?.some((r) => isSolveEmoji(r.emoji));
    return reacted;
  });
}

async function importChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.log(`  channel ${channelId} not found or not accessible — skipping`);
    return;
  }

  let logged = 0;
  let promoted = 0;

  const mainMessages = await fetchAllMessages(channel, IMPORT_LIMIT);
  for (const m of mainMessages) {
    if (m.author?.bot) continue;
    appendMessageToLog(m, channelId);
    logged += 1;
  }

  // Threads under the channel.
  const threads = [];
  if (typeof channel.threads?.fetchActive === 'function') {
    const active = await channel.threads.fetchActive().catch(() => null);
    const archived = await channel.threads.fetchArchived().catch(() => null);
    if (active) threads.push(...active.threads.values());
    if (archived) threads.push(...archived.threads.values());
  }

  for (const thread of threads) {
    // eslint-disable-next-line no-await-in-loop
    const msgs = await fetchAllMessages(thread, IMPORT_LIMIT);
    for (const m of msgs) {
      if (m.author?.bot) continue;
      appendMessageToLog(m, channelId);
      logged += 1;
    }

    if (DO_EXTRACT && msgs.length && looksSolved(msgs)) {
      const trigger = msgs[msgs.length - 1];
      // eslint-disable-next-line no-await-in-loop
      const entry = await promote({ triggerMessage: trigger, client }).catch((e) => {
        console.log(`    extract failed for thread ${thread.id}: ${e.message}`);
        return null;
      });
      if (entry) {
        promoted += 1;
        console.log(`    promoted thread "${thread.name}" → ${entry.title}`);
      }
    }
  }

  console.log(`  #${channel.name || channelId}: logged ${logged} messages, promoted ${promoted} threads`);
}

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN is not set.');

  const channels = getCaptureChannels();
  if (!channels.length) {
    throw new Error('KNOWLEDGE_CAPTURE_CHANNELS is empty — nothing to import.');
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });

  await client.login(token);
  console.log(`Importing history from ${channels.length} channel(s)${DO_EXTRACT ? ' (with extraction)' : ''}…`);

  try {
    for (const channelId of channels) {
      // eslint-disable-next-line no-await-in-loop
      await importChannel(client, channelId);
    }
  } finally {
    client.destroy();
  }

  console.log('Done. Run `npm run kb:reindex` to embed newly captured knowledge.');
}

main().catch((error) => {
  console.error('Import failed:', error.message);
  process.exit(1);
});
