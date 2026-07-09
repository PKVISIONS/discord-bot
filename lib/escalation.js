/**
 * Auto-escalation of unanswered questions.
 *
 * Watches the channels/threads configured in config/escalation.json. When a
 * question sits unanswered for `escalationMinutes` (default 40), the bot:
 *   1. tags the responsible role(s) in the same channel/thread, and
 *   2. DMs each member holding that role, with a link to the original message.
 *
 * A question is cleared before escalation if someone replies to it or reacts
 * with the resolved emoji (default ✅).
 *
 * Routing targets are ROLE NAMES (not user IDs) — same convention as
 * DEPLOY_ROLES. Routing picks by explicit #hashtag first (multiple allowed),
 * then falls back to keywords, then to the channel's default role.
 *
 * Optional ESCALATION_AUTO_HINT posts instant QA guidance for testers without
 * cancelling escalation (see lib/escalation-hint.js).
 */

const fs = require('fs');
const path = require('path');
const { maybePostEscalationHint } = require('./escalation-hint');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'escalation.json');
const PENDING_PATH = path.join(__dirname, '..', 'data', 'escalation-pending.json');

// channelId -> channelConfig (resolved on bot ready)
const resolvedChannels = new Map();
// messageId -> { channelId, authorId, createdAt, escalated }
const pendingMessages = new Map();

let cachedConfig;
let saveTimer = null;

const HASHTAG_RE = /#([\p{L}\p{N}_-]+)/gu;

function isEscalationEnabled() {
  return String(process.env.ESCALATION_ENABLED || '').toLowerCase() === 'true';
}

function loadConfigFile() {
  if (cachedConfig !== undefined) return cachedConfig;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    cachedConfig = parsed && parsed.channels ? parsed : null;
  } catch {
    cachedConfig = null;
  }
  return cachedConfig;
}

function getConfig() {
  return loadConfigFile();
}

function getEscalationMs(config) {
  const envMin = Number(process.env.ESCALATION_MINUTES);
  const minutes = Number.isFinite(envMin) && envMin > 0
    ? envMin
    : Number(config?.escalationMinutes) || 40;
  return minutes * 60 * 1000;
}

function getResolvedEmoji(config) {
  return config?.resolvedEmoji || '✅';
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function extractHashtags(text) {
  const normalized = normalize(text);
  const tags = [];
  const re = new RegExp(HASHTAG_RE.source, 'gu');
  let match;
  while ((match = re.exec(normalized)) !== null) {
    tags.push(match[1]);
  }
  return tags;
}

const QUESTION_WORDS = [
  'πως', 'ποτε', 'που', 'ποιος', 'ποια', 'ποιο', 'γιατι', 'τι', 'ποσο', 'ποσα',
  'μπορω', 'μπορουμε', 'μπορει', 'ειναι', 'εχει', 'εχουμε', 'θα', 'πρεπει',
  'how', 'why', 'what', 'when', 'where', 'who', 'which', 'can', 'could', 'should',
  'would', 'is', 'are', 'does', 'do', 'did', 'will',
];

function isLikelyQuestion(content) {
  const raw = String(content || '').trim();
  if (!raw) return false;
  if (raw.includes('?') || raw.includes(';') || raw.includes('\u037e')) return true;
  if (/#([\p{L}\p{N}_-]+)/u.test(raw)) return true;

  const words = normalize(raw).split(/\W+/).filter(Boolean);
  if (!words.length) return false;
  if (QUESTION_WORDS.includes(words[0])) return true;
  return words.slice(0, 6).some((w) => QUESTION_WORDS.includes(w));
}

function channelNameMatches(guildName, configName) {
  const a = normalize(guildName).replace(/\s+/g, '-');
  const b = normalize(configName).replace(/\s+/g, '-');
  return a === b || normalize(guildName) === normalize(configName);
}

function parseEnvChannelOverrides() {
  const overrides = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('ESCALATION_CHANNEL_') || !value?.trim()) continue;
    const name = key.slice('ESCALATION_CHANNEL_'.length).replace(/_/g, '-');
    overrides[normalize(name)] = value.trim();
  }
  return overrides;
}

/**
 * Resolve placeholder channel IDs to real IDs using guild channel names or
 * ESCALATION_CHANNEL_{name} env overrides.
 */
function bindChannelsFromGuild(guild, config) {
  resolvedChannels.clear();
  if (!config?.channels) return 0;

  const envOverrides = parseEnvChannelOverrides();
  let bound = 0;

  for (const [key, channelConfig] of Object.entries(config.channels)) {
    let channelId = null;

    const envKey = normalize(channelConfig.name || '');
    if (envOverrides[envKey]) {
      channelId = envOverrides[envKey];
    }

    if (!channelId && guild && channelConfig.name) {
      const found = guild.channels.cache.find(
        (ch) => channelNameMatches(ch.name, channelConfig.name),
      );
      channelId = found?.id || null;
    }

    if (!channelId && key && !String(key).includes('REPLACE_WITH')) {
      channelId = key;
    }

    if (channelId) {
      resolvedChannels.set(channelId, channelConfig);
      bound += 1;
    } else {
      console.warn(`[escalation] could not resolve channel "${channelConfig.name}" — set ESCALATION_CHANNEL_${(channelConfig.name || 'unknown').replace(/-/g, '_')}=<id>`);
    }
  }

  return bound;
}

function resolveChannelConfig(channel, config) {
  if (!channel) return null;
  if (resolvedChannels.has(channel.id)) return resolvedChannels.get(channel.id);

  if (config?.channels?.[channel.id]) return config.channels[channel.id];

  const isThread = typeof channel.isThread === 'function' && channel.isThread();
  if (isThread && channel.parentId) {
    if (resolvedChannels.has(channel.parentId)) {
      const parentConfig = resolvedChannels.get(channel.parentId);
      if (parentConfig.includeThreads) return parentConfig;
    }
    const parentConfig = config?.channels?.[channel.parentId];
    if (parentConfig?.includeThreads) return parentConfig;
  }
  return null;
}

function resolveOwners(channelConfig, messageContent) {
  const normalizedContent = normalize(messageContent);
  const rules = channelConfig.routingRules || [];
  const hashtags = extractHashtags(messageContent);

  if (hashtags.length > 0) {
    const matched = rules.filter(
      (rule) => rule.tag && hashtags.includes(normalize(rule.tag)),
    );
    if (matched.length > 0) {
      const seen = new Set();
      return matched
        .map((rule) => ({ role: rule.ownerRole, label: rule.label || null }))
        .filter((o) => {
          if (!o.role || seen.has(o.role)) return false;
          seen.add(o.role);
          return true;
        });
    }
  }

  for (const rule of rules) {
    const matched = (rule.keywords || []).some((kw) => normalizedContent.includes(normalize(kw)));
    if (matched) return [{ role: rule.ownerRole, label: rule.label || null }];
  }

  return [{ role: channelConfig.defaultOwnerRole, label: null }];
}

function loadPendingStore() {
  if (!fs.existsSync(PENDING_PATH)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
    const entries = parsed.entries || {};
    const now = Date.now();
    const config = getConfig();
    const maxAge = getEscalationMs(config) * 3;

    for (const [messageId, data] of Object.entries(entries)) {
      if (data.escalated) continue;
      if (now - data.createdAt > maxAge) continue;
      pendingMessages.set(messageId, data);
    }
  } catch {
    // ignore corrupt store
  }
}

function flushPendingStore() {
  fs.mkdirSync(path.dirname(PENDING_PATH), { recursive: true });
  const entries = Object.fromEntries(pendingMessages.entries());
  fs.writeFileSync(PENDING_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), entries }, null, 2));
}

function schedulePendingSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushPendingStore();
  }, 800);
  if (saveTimer.unref) saveTimer.unref();
}

function trackMessage(messageId, data) {
  pendingMessages.set(messageId, data);
  schedulePendingSave();
}

function untrackMessage(messageId) {
  if (pendingMessages.delete(messageId)) schedulePendingSave();
}

/**
 * Track new questions and clear parents answered by reply. Returns true when a
 * new question was tracked (for optional auto-hint).
 */
function handleChannelMessage(message) {
  if (!isEscalationEnabled()) return false;
  const config = getConfig();
  if (!config) return false;

  const channelConfig = resolveChannelConfig(message.channel, config);
  if (!channelConfig) return false;

  if (message.reference?.messageId) {
    if (pendingMessages.has(message.reference.messageId)) {
      untrackMessage(message.reference.messageId);
      console.log(`[escalation] ${message.reference.messageId} answered (reply)`);
    }
    return false;
  }

  if (config.questionsOnly !== false && !isLikelyQuestion(message.content)) return false;

  trackMessage(message.id, {
    channelId: message.channel.id,
    authorId: message.author.id,
    createdAt: Date.now(),
    escalated: false,
  });
  console.log(`[escalation] tracking question ${message.id} in #${channelConfig.name}`);
  return true;
}

async function handleChannelMessageWithHint(message) {
  const tracked = handleChannelMessage(message);
  if (tracked) {
    maybePostEscalationHint(message).catch((error) => {
      console.error('[escalation] auto-hint failed:', error.message);
    });
  }
}

function handleResolvedReaction(reaction, user) {
  if (!isEscalationEnabled()) return false;
  const config = getConfig();
  if (!config) return false;
  if (user?.bot) return false;
  if ((reaction.emoji?.name || '') !== getResolvedEmoji(config)) return false;

  const messageId = reaction.message?.id;
  if (messageId && pendingMessages.has(messageId)) {
    untrackMessage(messageId);
    console.log(`[escalation] ${messageId} resolved (${getResolvedEmoji(config)})`);
    return true;
  }
  return false;
}

async function getRoleMembers(guild, role) {
  try {
    await guild.members.fetch();
  } catch {
    // Server Members Intent may be off — use cache only.
  }
  return role.members.filter((m) => !m.user.bot);
}

async function escalateOne(client, messageId, data, config) {
  const channel = await client.channels.fetch(data.channelId).catch(() => null);
  if (!channel) {
    untrackMessage(messageId);
    return;
  }

  const channelConfig = resolveChannelConfig(channel, config);
  if (!channelConfig) {
    untrackMessage(messageId);
    return;
  }

  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (!msg) {
    untrackMessage(messageId);
    return;
  }

  const guild = channel.guild;
  const minutes = Math.round(getEscalationMs(config) / 60000);
  const owners = resolveOwners(channelConfig, msg.content);

  const resolved = owners
    .filter((o) => o.role)
    .map((o) => ({
      ...o,
      roleObj: guild?.roles?.cache.find((r) => r.name === o.role) || null,
    }));

  const mentionsText = resolved
    .map((o) => (o.roleObj ? `<@&${o.roleObj.id}>` : `@${o.role}`))
    .join(' ');
  const labelsText = resolved.map((o) => o.label).filter(Boolean).join(', ');
  const roleIds = resolved.map((o) => o.roleObj?.id).filter(Boolean);

  const missing = resolved.filter((o) => !o.roleObj).map((o) => o.role);
  if (missing.length) {
    console.warn(`[escalation] role(s) not found in guild: ${missing.join(', ')}`);
  }

  await channel.send({
    content: `⏰ ${mentionsText} — [Αυτό το μήνυμα](${msg.url}) περιμένει απάντηση εδώ και ${minutes} λεπτά.${labelsText ? ` (θέμα: ${labelsText})` : ''}`,
    reply: { messageReference: messageId, failIfNotExists: false },
    allowedMentions: { roles: roleIds, repliedUser: false },
  });

  for (const owner of resolved) {
    if (!owner.roleObj) continue;
    const members = await getRoleMembers(guild, owner.roleObj);
    if (!members.size) {
      console.warn(`[escalation] no reachable members for role ${owner.role} (enable Server Members Intent for DMs)`);
    }
    for (const member of members.values()) {
      await member.send(
        `⏰ Εκκρεμής ερώτηση στο #${channelConfig.name} χωρίς απάντηση για ${minutes} λεπτά${owner.label ? ` (θέμα: ${owner.label})` : ''}:\n${msg.url}`,
      ).catch(() => {});
    }
  }

  data.escalated = true;
  schedulePendingSave();
  console.log(`[escalation] escalated ${messageId} in #${channelConfig.name} → ${resolved.map((o) => o.role).join(', ')}`);
}

async function checkPendingMessages(client) {
  if (!isEscalationEnabled()) return;
  const config = getConfig();
  if (!config) return;

  const escalationMs = getEscalationMs(config);
  const now = Date.now();

  for (const [messageId, data] of pendingMessages.entries()) {
    if (data.escalated) continue;
    if (now - data.createdAt < escalationMs) continue;
    try {
      await escalateOne(client, messageId, data, config);
    } catch (error) {
      console.error(`[escalation] failed for ${messageId}:`, error.message);
      untrackMessage(messageId);
    }
  }
}

function escalationStatus() {
  if (!isEscalationEnabled()) return 'off';
  const config = getConfig();
  if (!config) return 'off (no config/escalation.json)';
  const count = resolvedChannels.size || Object.keys(config.channels || {}).length;
  const minutes = Math.round(getEscalationMs(config) / 60000);
  const pending = pendingMessages.size;
  const hint = String(process.env.ESCALATION_AUTO_HINT || '').toLowerCase() === 'true' ? ' + hints' : '';
  return `on (${count} channels, ${minutes}m, ${pending} pending${hint})`;
}

function startEscalation(client) {
  if (!isEscalationEnabled()) {
    console.log('[escalation] disabled (set ESCALATION_ENABLED=true)');
    return;
  }

  const config = getConfig();
  if (!config) {
    console.log('[escalation] no config/escalation.json — disabled');
    return;
  }

  loadPendingStore();

  const guildId = process.env.DISCORD_GUILD_ID;
  const guild = guildId ? client.guilds.cache.get(guildId) : client.guilds.cache.first();
  const bound = bindChannelsFromGuild(guild, config);

  if (!bound) {
    console.warn('[escalation] no channels resolved — check channel names or ESCALATION_CHANNEL_* env vars');
  }

  const minutes = Math.round(getEscalationMs(config) / 60000);
  console.log(`[escalation] watching ${bound} channels · escalate after ${minutes}m · ${pendingMessages.size} restored pending`);

  setInterval(() => {
    checkPendingMessages(client).catch((e) => console.error('[escalation] check failed:', e.message));
  }, 60 * 1000);
}

module.exports = {
  isEscalationEnabled,
  handleChannelMessage,
  handleChannelMessageWithHint,
  handleResolvedReaction,
  checkPendingMessages,
  startEscalation,
  escalationStatus,
  bindChannelsFromGuild,
  resolveOwners,
  resolveChannelConfig,
  isLikelyQuestion,
  normalize,
  extractHashtags,
  _pendingMessages: pendingMessages,
  _resolvedChannels: resolvedChannels,
};
