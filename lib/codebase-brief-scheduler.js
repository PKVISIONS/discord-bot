/**
 * Post the daily codebase brief to #tameiaki-ai-briefs.
 */

const fs = require('fs');
const path = require('path');
const { AttachmentBuilder } = require('discord.js');
const { runDailyCodebaseBrief } = require('./codebase-brief');
const { buildBriefDocxBuffer } = require('./codebase-brief-docx');

const DEFAULT_CHANNEL_ID = '1525087788654133319';
const STATE_PATH = path.join(__dirname, '..', 'data', 'codebase-brief-state.json');

function isBriefEnabled() {
  return process.env.CODEBASE_BRIEF_ENABLED === 'true';
}

function getBriefChannelId() {
  return process.env.CODEBASE_BRIEF_CHANNEL_ID || DEFAULT_CHANNEL_ID;
}

function readState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return {};
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function formatDateKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function getZonedHourMinute(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  return { hour, minute };
}

async function buildAttachment(brief) {
  const footer = `Generated automatically by discord-linear-bot · ${new Date().toISOString()}`;
  const buffer = await buildBriefDocxBuffer(brief.markdown, { footer });
  return new AttachmentBuilder(buffer, { name: brief.filename });
}

async function deliverCodebaseBrief(discordClient, brief) {
  const channelId = getBriefChannelId();
  const channel = await discordClient.channels.fetch(channelId);
  if (!channel?.isTextBased?.()) {
    throw new Error(`CODEBASE_BRIEF_CHANNEL_ID ${channelId} is not a text channel.`);
  }

  const attachment = await buildAttachment(brief);
  const summary = brief.commitCount
    ? `${brief.commitCount} commit${brief.commitCount === 1 ? '' : 's'}`
    : 'no commits';

  await channel.send({
    content: [
      `📊 **BRIEF ΠΛΑΝΟΥ ΗΜΕΡΑΣ** — ${brief.reportDateLabel}`,
      `Repository: \`${brief.repoFullName}\` · lookback ${brief.lookbackDays || 3} ημέρες · ${summary}`,
      `📎 \`${brief.filename}\``,
    ].join('\n'),
    files: [attachment],
  });
}

async function publishDailyCodebaseBrief(discordClient, { force = false, onLog = console.log } = {}) {
  const timeZone = process.env.CODEBASE_BRIEF_TZ || 'Europe/Athens';
  const todayKey = formatDateKey(new Date(), timeZone);
  const state = readState();

  if (!force && state.lastRunDateKey === todayKey) {
    onLog(`[codebase-brief] already published for ${todayKey}`);
    return { skipped: true, reason: 'already-ran-today' };
  }

  onLog('[codebase-brief] generating brief…');
  const brief = await runDailyCodebaseBrief({ timeZone });
  await deliverCodebaseBrief(discordClient, brief);

  writeState({
    lastRunDateKey: todayKey,
    lastReportDateKey: brief.reportDateKey,
    lastPublishedAt: new Date().toISOString(),
    filename: brief.filename,
  });

  onLog(`[codebase-brief] published ${brief.filename} to #${getBriefChannelId()}`);
  return { skipped: false, brief };
}

function getScheduledHourMinute() {
  const hour = Number(process.env.CODEBASE_BRIEF_HOUR ?? 9);
  const minute = Number(process.env.CODEBASE_BRIEF_MINUTE ?? 0);
  return {
    hour: Number.isFinite(hour) ? hour : 9,
    minute: Number.isFinite(minute) ? minute : 0,
  };
}

function startCodebaseBriefScheduler(discordClient, { onLog = console.log } = {}) {
  if (!isBriefEnabled()) {
    onLog('[codebase-brief] disabled (set CODEBASE_BRIEF_ENABLED=true)');
    return null;
  }

  const timeZone = process.env.CODEBASE_BRIEF_TZ || 'Europe/Athens';
  const { hour, minute } = getScheduledHourMinute();
  let running = false;

  const tick = async () => {
    const now = new Date();
    const zoned = getZonedHourMinute(now, timeZone);
    if (zoned.hour !== hour || zoned.minute !== minute) return;
    if (running) return;

    running = true;
    try {
      await publishDailyCodebaseBrief(discordClient, { onLog });
    } catch (error) {
      onLog(`[codebase-brief] failed: ${error.message}`);
      console.error('[codebase-brief] failed:', error);
    } finally {
      running = false;
    }
  };

  const intervalMs = Number(process.env.CODEBASE_BRIEF_CHECK_MS || 30000);
  const timer = setInterval(() => {
    tick().catch((error) => onLog(`[codebase-brief] tick error: ${error.message}`));
  }, intervalMs);

  onLog(`[codebase-brief] scheduler on — daily at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${timeZone} → channel ${getBriefChannelId()}`);

  return () => clearInterval(timer);
}

module.exports = {
  isBriefEnabled,
  getBriefChannelId,
  deliverCodebaseBrief,
  publishDailyCodebaseBrief,
  startCodebaseBriefScheduler,
};
