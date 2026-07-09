/**
 * Passive Discord capture — the raw safety net.
 *
 * Appends every message in designated support channels/threads to
 * data/discord-capture/{channelId}.jsonl. No AI here; this guarantees nothing
 * is lost even before a thread is promoted into curated knowledge.
 */

const fs = require('fs');
const path = require('path');

const CAPTURE_DIR = path.join(__dirname, '..', 'data', 'discord-capture');
const LINK_RE = /(https?:\/\/[^\s<>()]+)/g;

function isCaptureEnabled() {
  return String(process.env.KNOWLEDGE_CAPTURE_ENABLED || '').toLowerCase() === 'true';
}

function getCaptureChannels() {
  return String(process.env.KNOWLEDGE_CAPTURE_CHANNELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * If the message belongs to a configured capture channel (directly or via a
 * thread whose parent is configured), returns the top-level channel id used as
 * the log file key. Otherwise null.
 */
function resolveCaptureChannelId(message) {
  const channels = getCaptureChannels();
  if (!channels.length) return null;

  const channelId = message.channel?.id;
  const parentId = message.channel?.parentId || null;

  if (channelId && channels.includes(channelId)) return channelId;
  if (parentId && channels.includes(parentId)) return parentId;
  return null;
}

function extractLinks(content) {
  const matches = String(content || '').match(LINK_RE);
  return matches ? Array.from(new Set(matches)) : [];
}

function getAttachmentNames(message) {
  if (!message.attachments?.size) return [];
  return Array.from(message.attachments.values()).map((a) => a.name || a.url);
}

function logFilePath(channelId) {
  return path.join(CAPTURE_DIR, `${channelId}.jsonl`);
}

function buildRecord(message, fileChannelId) {
  const isThread = typeof message.channel?.isThread === 'function' && message.channel.isThread();
  return {
    messageId: message.id,
    channelId: fileChannelId,
    sourceChannelId: message.channel?.id || fileChannelId,
    threadId: isThread ? message.channel.id : null,
    threadName: isThread ? message.channel.name : null,
    authorId: message.author?.id || '',
    author: message.author?.username || '',
    content: message.content || '',
    links: extractLinks(message.content),
    attachments: getAttachmentNames(message),
    url: message.url || '',
    timestamp: message.createdAt ? message.createdAt.toISOString() : new Date().toISOString(),
  };
}

/**
 * Append a message to its channel log if capture is enabled and the channel is
 * configured. Returns the file channel id when written, else null.
 */
function captureMessage(message) {
  if (!isCaptureEnabled()) return null;
  const fileChannelId = resolveCaptureChannelId(message);
  if (!fileChannelId) return null;
  if (!message.content && !message.attachments?.size) return null;

  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  const record = buildRecord(message, fileChannelId);
  fs.appendFileSync(logFilePath(fileChannelId), `${JSON.stringify(record)}\n`);
  return fileChannelId;
}

function readChannelLog(channelId) {
  const file = logFilePath(channelId);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

/** All logged messages for a given thread across channel logs. */
function readThreadMessages(threadId) {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  const results = [];
  for (const file of fs.readdirSync(CAPTURE_DIR)) {
    if (!file.endsWith('.jsonl')) continue;
    const channelId = file.replace('.jsonl', '');
    for (const record of readChannelLog(channelId)) {
      if (record.threadId === threadId || record.messageId === threadId) results.push(record);
    }
  }
  return results.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

/**
 * Append a message to a specific channel log file, bypassing the enabled/
 * channel checks. Used by the history importer which already knows the target.
 */
function appendMessageToLog(message, fileChannelId) {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  const record = buildRecord(message, fileChannelId);
  fs.appendFileSync(logFilePath(fileChannelId), `${JSON.stringify(record)}\n`);
  return record;
}

module.exports = {
  CAPTURE_DIR,
  isCaptureEnabled,
  getCaptureChannels,
  resolveCaptureChannelId,
  extractLinks,
  getAttachmentNames,
  captureMessage,
  appendMessageToLog,
  buildRecord,
  readChannelLog,
  readThreadMessages,
  logFilePath,
};
