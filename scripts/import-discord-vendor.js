#!/usr/bin/env node
/**
 * Backfill vendor ingest from historical Discord messages with attachments.
 *
 * Usage: node scripts/import-discord-vendor.js
 *
 * Env:
 *   KNOWLEDGE_VENDOR_INGEST_ENABLED=true
 *   KNOWLEDGE_VENDOR_CHANNELS=...   (defaults to KNOWLEDGE_CAPTURE_CHANNELS)
 *   KB_IMPORT_LIMIT                 max messages per channel/thread (default 500)
 */

require('dotenv').config({ override: true });

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const {
  getVendorIngestChannels,
  ingestAttachment,
  isVendorIngestEnabled,
} = require('../lib/discord-vendor-ingest');

const IMPORT_LIMIT = Number(process.env.KB_IMPORT_LIMIT || 500);

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

async function processChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`  skip ${channelId}: not a text channel`);
    return { ingested: 0, skipped: 0 };
  }

  const messages = await fetchAllMessages(channel, IMPORT_LIMIT);
  let ingested = 0;
  let skipped = 0;

  for (const message of messages.reverse()) {
    if (!message.attachments?.size) continue;
    for (const attachment of message.attachments.values()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await ingestAttachment(message, attachment);
        if (!result) continue;
        if (result.skipped) skipped += 1;
        else ingested += 1;
      } catch (error) {
        console.warn(`    failed ${attachment.name}: ${error.message}`);
      }
    }
  }

  if (channel.threads?.fetchActive) {
    const threads = await channel.threads.fetchActive().catch(() => null);
    for (const thread of threads?.threads?.values() || []) {
      // eslint-disable-next-line no-await-in-loop
      const nested = await processChannel(client, thread.id);
      ingested += nested.ingested;
      skipped += nested.skipped;
    }
  }

  console.log(`  #${channel.name || channel.id}: ingested=${ingested} skipped=${skipped}`);
  return { ingested, skipped };
}

async function main() {
  if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is not set.');
  if (!isVendorIngestEnabled()) {
    throw new Error('Set KNOWLEDGE_VENDOR_INGEST_ENABLED=true before importing.');
  }

  const channels = getVendorIngestChannels();
  if (!channels.length) {
    throw new Error('KNOWLEDGE_VENDOR_CHANNELS / KNOWLEDGE_CAPTURE_CHANNELS is empty.');
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  await client.login(process.env.DISCORD_TOKEN);
  console.log(`Importing vendor attachments from ${channels.length} channel(s)…`);

  let totalIngested = 0;
  let totalSkipped = 0;
  for (const channelId of channels) {
    // eslint-disable-next-line no-await-in-loop
    const result = await processChannel(client, channelId);
    totalIngested += result.ingested;
    totalSkipped += result.skipped;
  }

  console.log(`Done. ingested=${totalIngested} skipped=${totalSkipped}`);
  await client.destroy();
}

main().catch((error) => {
  console.error('Import failed:', error.message);
  process.exit(1);
});
