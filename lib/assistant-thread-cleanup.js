/**
 * Delete assistant hub threads older than a configured age (default 24h).
 */

const { PermissionFlagsBits } = require('discord.js');
const { getAssistantHubChannelIds } = require('./assistant-hub');

const DEFAULT_MAX_AGE_HOURS = 24;
const DEFAULT_CHECK_MS = 30 * 60 * 1000;
const ARCHIVED_FETCH_LIMIT = 100;

const THREAD_DELETE_PERMISSIONS = [
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.Administrator,
];

function isCleanupEnabled() {
  if (process.env.ASSISTANT_THREAD_CLEANUP === 'false') return false;
  return getAssistantHubChannelIds().length > 0;
}

function getMaxAgeMs() {
  const hours = Number(process.env.ASSISTANT_THREAD_MAX_AGE_HOURS || DEFAULT_MAX_AGE_HOURS);
  if (!Number.isFinite(hours) || hours < 1) return DEFAULT_MAX_AGE_HOURS * 60 * 60 * 1000;
  return hours * 60 * 60 * 1000;
}

function getCheckIntervalMs() {
  const ms = Number(process.env.ASSISTANT_THREAD_CLEANUP_CHECK_MS || DEFAULT_CHECK_MS);
  return Number.isFinite(ms) && ms >= 60_000 ? ms : DEFAULT_CHECK_MS;
}

function threadAgeMs(thread) {
  const created = thread.createdTimestamp || thread.createdAt?.getTime?.();
  if (!created) return 0;
  return Date.now() - created;
}

function isStaleThread(thread, maxAgeMs) {
  if (!thread || thread.deleted) return false;
  if (typeof thread.isThread === 'function' && !thread.isThread()) return false;
  return threadAgeMs(thread) >= maxAgeMs;
}

async function resolveGuildMember(channel, discordClient) {
  const guild = channel.guild;
  if (!guild) return null;
  if (guild.members?.me) return guild.members.me;
  try {
    return await guild.members.fetch(discordClient.user.id);
  } catch {
    return null;
  }
}

function canDeleteThreadsInChannel(channel, member) {
  if (!channel || !member) return false;
  const perms = channel.permissionsFor(member);
  if (!perms) return false;
  return THREAD_DELETE_PERMISSIONS.some((flag) => perms.has(flag));
}

function formatPermissionFix(channel) {
  const label = channel.name ? `#${channel.name}` : channel.id;
  return (
    `[thread-cleanup] Missing Permissions on ${label}. `
    + 'Give the bot role **Manage Threads** (or **Manage Channels**) on that channel in Discord → Channel settings → Permissions.'
  );
}

async function verifyCleanupPermissions(discordClient, { onLog = console.log } = {}) {
  const hubIds = getAssistantHubChannelIds();
  const results = [];

  for (const channelId of hubIds) {
    let channel;
    try {
      channel = await discordClient.channels.fetch(channelId);
    } catch (error) {
      onLog(`[thread-cleanup] cannot fetch channel ${channelId}: ${error.message}`);
      results.push({ channelId, ok: false, reason: 'fetch-failed' });
      continue;
    }

    const member = await resolveGuildMember(channel, discordClient);
    const ok = canDeleteThreadsInChannel(channel, member);
    if (!ok) onLog(formatPermissionFix(channel));
    results.push({ channelId, channelName: channel.name, ok });
  }

  return results;
}

async function fetchAllChannelThreads(channel) {
  const threads = new Map();

  const add = (thread) => {
    if (thread?.id) threads.set(thread.id, thread);
  };

  channel.threads?.cache?.forEach(add);

  try {
    const active = await channel.threads.fetchActive();
    active?.threads?.forEach(add);
  } catch (error) {
    console.warn(`[thread-cleanup] fetchActive failed #${channel.id}: ${error.message}`);
  }

  try {
    let before;
    let pages = 0;
    let lastPageSize = 0;

    do {
      const options = { limit: ARCHIVED_FETCH_LIMIT, type: 'public' };
      if (before) options.before = before;

      const archived = await channel.threads.fetchArchived(options);
      if (!archived?.threads?.size) break;

      archived.threads.forEach(add);
      lastPageSize = archived.threads.size;
      before = archived.threads.last()?.id;
      pages += 1;
    } while (lastPageSize === ARCHIVED_FETCH_LIMIT && pages < 20);
  } catch (error) {
    console.warn(`[thread-cleanup] fetchArchived failed #${channel.id}: ${error.message}`);
  }

  return [...threads.values()];
}

async function deleteThread(thread, { onLog = console.log } = {}) {
  const ageHours = Math.round(threadAgeMs(thread) / (60 * 60 * 1000));
  try {
    if (thread.archived) {
      await thread.setArchived(false, 'Auto-cleanup: unarchive before delete');
    }
    if (thread.locked) {
      await thread.setLocked(false, 'Auto-cleanup: unlock before delete');
    }
    await thread.delete(`Auto-cleanup: assistant thread older than ${ageHours}h`);
    onLog(`[thread-cleanup] deleted #${thread.name} (${thread.id}, ${ageHours}h)`);
    return { deleted: true, threadId: thread.id };
  } catch (error) {
    const missingPerms = /missing permissions/i.test(error.message);
    onLog(`[thread-cleanup] failed to delete ${thread.id}: ${error.message}`);
    return { deleted: false, threadId: thread.id, error: error.message, missingPerms };
  }
}

async function cleanupChannelThreads(channel, {
  maxAgeMs,
  dryRun = false,
  onLog = console.log,
  discordClient = null,
} = {}) {
  const member = discordClient ? await resolveGuildMember(channel, discordClient) : null;
  if (!dryRun && discordClient && !canDeleteThreadsInChannel(channel, member)) {
    onLog(formatPermissionFix(channel));
    return { scanned: 0, stale: 0, deleted: 0, failed: 0, permissionDenied: true };
  }

  const threads = await fetchAllChannelThreads(channel);
  const stale = threads.filter((thread) => isStaleThread(thread, maxAgeMs));

  if (!stale.length) {
    return { scanned: threads.length, stale: 0, deleted: 0, failed: 0 };
  }

  onLog(`[thread-cleanup] #${channel.name || channel.id}: ${stale.length}/${threads.length} threads older than ${Math.round(maxAgeMs / 3600000)}h`);

  let deleted = 0;
  let failed = 0;

  for (const thread of stale) {
    if (dryRun) {
      const ageHours = Math.round(threadAgeMs(thread) / (60 * 60 * 1000));
      onLog(`[thread-cleanup] dry-run would delete #${thread.name} (${ageHours}h)`);
      deleted += 1;
      continue;
    }

    const result = await deleteThread(thread, { onLog });
    if (result.deleted) deleted += 1;
    else {
      failed += 1;
      if (result.missingPerms) {
        onLog(formatPermissionFix(channel));
        break;
      }
    }
  }

  return { scanned: threads.length, stale: stale.length, deleted, failed };
}

async function cleanupAssistantHubThreads(discordClient, { dryRun = false, onLog = console.log } = {}) {
  if (!isCleanupEnabled()) {
    return { skipped: true, reason: 'disabled' };
  }

  const hubIds = getAssistantHubChannelIds();
  const maxAgeMs = getMaxAgeMs();
  const totals = { channels: 0, scanned: 0, stale: 0, deleted: 0, failed: 0 };

  for (const channelId of hubIds) {
    let channel;
    try {
      channel = await discordClient.channels.fetch(channelId);
    } catch (error) {
      onLog(`[thread-cleanup] cannot fetch channel ${channelId}: ${error.message}`);
      continue;
    }

    if (!channel?.isTextBased?.() || typeof channel.threads?.fetchActive !== 'function') {
      onLog(`[thread-cleanup] skip ${channelId}: not a text channel with threads`);
      continue;
    }

    totals.channels += 1;
    const result = await cleanupChannelThreads(channel, {
      maxAgeMs,
      dryRun,
      onLog,
      discordClient,
    });
    totals.scanned += result.scanned;
    totals.stale += result.stale;
    totals.deleted += result.deleted;
    totals.failed += result.failed;
    if (result.permissionDenied) totals.permissionDenied = true;
  }

  if (totals.stale > 0 || totals.scanned > 0) {
    onLog(
      `[thread-cleanup] done — scanned ${totals.scanned}, stale ${totals.stale}, `
      + `deleted ${totals.deleted}, failed ${totals.failed}`,
    );
  }

  return { skipped: false, ...totals, maxAgeHours: Math.round(maxAgeMs / 3600000) };
}

function cleanupStatus() {
  if (!isCleanupEnabled()) return 'off';
  const hubs = getAssistantHubChannelIds();
  const hours = Number(process.env.ASSISTANT_THREAD_MAX_AGE_HOURS || DEFAULT_MAX_AGE_HOURS);
  return `on (${hours}h, ${hubs.length} hub channel${hubs.length === 1 ? '' : 's'})`;
}

function startAssistantThreadCleanupScheduler(discordClient, { onLog = console.log } = {}) {
  if (!isCleanupEnabled()) {
    onLog('[thread-cleanup] disabled (no ASSISTANT_HUB_CHANNELS / KNOWLEDGE_CAPTURE_CHANNELS, or ASSISTANT_THREAD_CLEANUP=false)');
    return null;
  }

  const intervalMs = getCheckIntervalMs();
  const maxAgeHours = Math.round(getMaxAgeMs() / 3600000);
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await cleanupAssistantHubThreads(discordClient, { onLog });
    } catch (error) {
      onLog(`[thread-cleanup] tick failed: ${error.message}`);
      console.error('[thread-cleanup] tick failed:', error);
    } finally {
      running = false;
    }
  };

  tick().catch((error) => onLog(`[thread-cleanup] initial run failed: ${error.message}`));

  verifyCleanupPermissions(discordClient, { onLog }).catch((error) => {
    onLog(`[thread-cleanup] permission check failed: ${error.message}`);
  });

  const timer = setInterval(() => {
    tick().catch((error) => onLog(`[thread-cleanup] tick error: ${error.message}`));
  }, intervalMs);

  onLog(`[thread-cleanup] scheduler on — delete threads older than ${maxAgeHours}h, check every ${Math.round(intervalMs / 60000)} min`);

  return () => clearInterval(timer);
}

module.exports = {
  isCleanupEnabled,
  getMaxAgeMs,
  canDeleteThreadsInChannel,
  verifyCleanupPermissions,
  cleanupAssistantHubThreads,
  cleanupChannelThreads,
  fetchAllChannelThreads,
  isStaleThread,
  cleanupStatus,
  startAssistantThreadCleanupScheduler,
};
