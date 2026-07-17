/**
 * Discord → n8n bridge
 *
 * Supports:
 * - /n8n-linear slash command in servers
 * - Direct messages (when DM_ONLY is not false)
 * - @mentions in servers (when DM_ONLY=false)
 */

require('dotenv').config({ override: true });

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[fatal] uncaughtException:', error);
  process.exit(1);
});

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  Events,
} = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const BOT_USER_ID = process.env.BOT_USER_ID || '';
const N8N_WEBHOOK = process.env.N8N_WEBHOOK || '';
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '';
const LINEAR_WORKSPACE = process.env.LINEAR_WORKSPACE || 'techflowlabs';
const DM_ONLY = process.env.DM_ONLY !== 'false';

const GITHUB_REPO = process.env.GITHUB_REPO || 'semantic-software/EmblemTameiaki';
const DEPLOY_ROLES = ['Developer', 'Admin'];

function githubExecuteStatus() {
  const missing = [];
  if (!process.env.GITHUB_TOKEN) missing.push('GITHUB_TOKEN');
  if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (!missing.length) return 'on';
  return `off (need ${missing.join(', ')})`;
}

function commitReviewStatus() {
  const parts = [];

  if (process.env.COMMIT_AUTO_REVIEW === 'true') {
    const autoMissing = [];
    if (!process.env.OPENAI_API_KEY) autoMissing.push('OPENAI_API_KEY');
    if (!process.env.GITHUB_TOKEN) autoMissing.push('GITHUB_TOKEN');
    if (!process.env.DISCORD_GUILD_ID && !process.env.DISCORD_COMMIT_SUMMARY_CHANNEL_ID) {
      autoMissing.push('DISCORD_GUILD_ID or DISCORD_COMMIT_SUMMARY_CHANNEL_ID');
    }
    parts.push(autoMissing.length ? `poll off (need ${autoMissing.join(', ')})` : 'poll on');
  }

  if (process.env.COMMIT_REVIEW_ENABLED === 'true') {
    const webhookMissing = [];
    if (!process.env.GITHUB_WEBHOOK_SECRET) webhookMissing.push('GITHUB_WEBHOOK_SECRET');
    if (!process.env.OPENAI_API_KEY) webhookMissing.push('OPENAI_API_KEY');
    if (!process.env.GITHUB_TOKEN) webhookMissing.push('GITHUB_TOKEN');
    if (!process.env.DISCORD_GUILD_ID && !process.env.DISCORD_COMMIT_SUMMARY_CHANNEL_ID) {
      webhookMissing.push('DISCORD_GUILD_ID or DISCORD_COMMIT_SUMMARY_CHANNEL_ID');
    }
    parts.push(webhookMissing.length ? `webhook off (need ${webhookMissing.join(', ')})` : 'webhook on');
  }

  if (!parts.length) return 'off (set COMMIT_AUTO_REVIEW=true and/or COMMIT_REVIEW_ENABLED=true)';
  return parts.join(' | ');
}

function knowledgeStatus() {
  const parts = [];
  try {
    const { stats } = require('./lib/vector-store');
    const { knowledgeReindexStatus } = require('./lib/knowledge-reindex-sync');
    const s = stats();
    parts.push(s.total ? `index ${s.total} chunks` : 'index empty');
    parts.push(knowledgeReindexStatus());
  } catch {
    parts.push('index n/a');
  }

  if (process.env.KNOWLEDGE_CAPTURE_ENABLED === 'true') {
    const channels = (process.env.KNOWLEDGE_CAPTURE_CHANNELS || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    parts.push(channels.length ? `capture ${channels.length} ch` : 'capture on (no channels)');
  } else {
    parts.push('capture off');
  }

  if (process.env.KNOWLEDGE_REVIEW_CHANNEL) parts.push('review on');
  if (process.env.ANSWER_VERIFY === 'true') parts.push('verify on');

  try {
    const { getAssistantHubChannelIds } = require('./lib/assistant-hub');
    const hubs = getAssistantHubChannelIds();
    if (hubs.length) parts.push(`assistant hub ${hubs.length} ch`);
  } catch {
    // ignore
  }

  return parts.join(' | ');
}

function hasDeployPermission(member) {
  if (!member) return false;
  return member.roles.cache.some(r => DEPLOY_ROLES.includes(r.name));
}

async function triggerGitHubBuild(buildType, branch) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set in .env');

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/ci.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: branch, inputs: { build_type: buildType } }),
    },
  );

  // 204 No Content = success; anything else is an error
  if (res.status !== 204) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text}`);
  }
}

async function handleDeployCommand(interaction) {
  if (!hasDeployPermission(interaction.member)) {
    await interaction.reply({
      content: '⛔ You need the **Developer** or **Admin** role to trigger builds.',
      ephemeral: true,
    });
    return;
  }

  const buildType = interaction.options.getString('type', true);
  const branchInput = interaction.options.getString('branch');

  let branch;
  if (buildType === 'qa') {
    branch = 'develop';
  } else if (buildType === 'prod') {
    branch = 'main';
  } else {
    if (!branchInput) {
      await interaction.reply({
        content: '❌ **DEV** builds require a `branch` argument.\nExample: `/deploy type:dev branch:feature/my-feature`',
        ephemeral: true,
      });
      return;
    }
    if (branchInput === 'main' || branchInput === 'develop') {
      await interaction.reply({
        content: `❌ DEV builds are not allowed on \`${branchInput}\`. Use a feature branch.`,
        ephemeral: true,
      });
      return;
    }
    branch = branchInput;
  }

  const hub = await createHubSession(interaction);

  if (buildType === 'prod') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('deploy_prod_confirm')
        .setLabel('Yes, deploy PROD')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('deploy_prod_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    );

    const confirmMsg = hub.inHub
      ? await hub.reply({
        content: `⚠️ **${interaction.user.username}** wants to trigger a **PROD** build on \`main\`. Confirm or cancel within 30 seconds.`,
        components: [row],
      })
      : await interaction.reply({
        content: `⚠️ **${interaction.user.username}** wants to trigger a **PROD** build on \`main\`. Confirm or cancel within 30 seconds.`,
        components: [row],
        fetchReply: true,
      });

    let btn;
    try {
      btn = await confirmMsg.awaitMessageComponent({
        filter: (i) => i.user.id === interaction.user.id,
        time: 30_000,
        componentType: ComponentType.Button,
      });
    } catch {
      const timeout = '⏱️ PROD confirmation timed out. Build cancelled.';
      if (hub.inHub) await hub.editReply({ content: timeout, components: [] });
      else await interaction.editReply({ content: timeout, components: [] });
      return;
    }

    if (btn.customId === 'deploy_prod_cancel') {
      const cancelled = `❌ PROD build cancelled by **${interaction.user.username}**.`;
      await btn.update({ content: cancelled, components: [] });
      return;
    }

    await btn.update({ content: '🚀 Triggering **PROD** build on `main`…', components: [] });

    try {
      await triggerGitHubBuild('prod', 'main');
      const success = `✅ **PROD** build triggered on \`main\` by **${interaction.user.username}**.\n🔗 https://github.com/${GITHUB_REPO}/actions`;
      if (hub.inHub) await hub.editReply(success);
      else await interaction.editReply(success);
    } catch (err) {
      console.error('[deploy] GitHub API error:', err);
      const fail = `❌ Failed to trigger PROD build: ${err.message}`;
      if (hub.inHub) await hub.editReply(fail);
      else await interaction.editReply(fail);
    }
    return;
  }

  if (!hub.inHub) await interaction.deferReply();
  else await hub.sendLoading(`🚀 Triggering **${buildType.toUpperCase()}** build on \`${branch}\`…`);

  try {
    await triggerGitHubBuild(buildType, branch);
    const label = buildType.toUpperCase();
    const success = `✅ **${label}** build triggered on \`${branch}\` by **${interaction.user.username}**.\n🔗 https://github.com/${GITHUB_REPO}/actions`;
    if (hub.inHub) await hub.sendMain(success);
    else await interaction.editReply(success);
  } catch (err) {
    console.error('[deploy] GitHub API error:', err);
    const fail = `❌ Failed to trigger ${buildType.toUpperCase()} build: ${err.message}`;
    if (hub.inHub) await hub.editReply(fail);
    else await interaction.editReply(fail);
  }
}

const pendingPlans = require('./pending-plans');
const { executePlan } = require('./lib/github-plan-executor');
const { createWebhookServer } = require('./lib/webhook-server');
const { startAutoCommitReview } = require('./lib/auto-commit-review');
const { parseCommitSummaryCommand } = require('./lib/commit-summary-command');
const {
  startCommitSummaryFlow,
  handleSelectInteraction: handleCommitSummarySelect,
} = require('./lib/commit-summary-flow');
const { parseSalesSupportCommand } = require('./lib/sales-support-command');
const {
  startSalesSupportFlow,
  handleSalesSupportInteraction,
  handleSelectInteraction: handleSalesSupportSelect,
} = require('./lib/sales-support-flow');
const {
  startGitHubIssueFlow,
  handleSelectInteraction: handleGitHubIssueSelect,
} = require('./lib/github-issue-flow');
const { deliverSalesSupportResult, tryHandleSalesSupportSourceReply } = require('./lib/sales-support-delivery');
const { captureMessage, isCaptureEnabled } = require('./lib/discord-capture-log');
const {
  handleSolveReaction,
  handleKbSaveCommand,
} = require('./lib/knowledge-promotion');
const { handleReviewApprovalReaction } = require('./lib/knowledge-review');
const { parseAppStatusCommand } = require('./lib/app-status-command');
const { runAppStatusAssistant, deliverAppStatusResult } = require('./lib/app-status-assistant');
const { handleLeadsInteraction } = require('./lib/leads-flow');
const {
  buildSlashCommandsPayload,
  buildHelpMessages,
  getSlashCommandNamesLine,
} = require('./lib/slash-commands');
const {
  startDevAssistantFlow,
  handleSelectInteraction: handleDevSelect,
  deliverDevResult,
} = require('./lib/dev-assistant-flow');
const {
  isEscalationEnabled,
  handleChannelMessageWithHint,
  handleResolvedReaction: handleEscalationResolved,
  startEscalation,
  escalationStatus,
} = require('./lib/escalation');
const { createHubSession } = require('./lib/assistant-hub-session');
const {
  isBriefEnabled,
  startCodebaseBriefScheduler,
} = require('./lib/codebase-brief-scheduler');
const { startKnowledgeReindexWatcher } = require('./lib/knowledge-reindex-sync');
const {
  startAssistantThreadCleanupScheduler,
  cleanupStatus,
} = require('./lib/assistant-thread-cleanup');

function codebaseBriefStatus() {
  if (!isBriefEnabled()) return 'off';
  const missing = [];
  if (!process.env.GITHUB_TOKEN) missing.push('GITHUB_TOKEN');
  if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (!process.env.DISCORD_TOKEN) missing.push('DISCORD_TOKEN');
  if (missing.length) return `off (need ${missing.join(', ')})`;
  const hour = process.env.CODEBASE_BRIEF_HOUR ?? 9;
  const tz = process.env.CODEBASE_BRIEF_TZ || 'Europe/Athens';
  return `on (${hour}:00 ${tz})`;
}

if (!DISCORD_TOKEN || !BOT_USER_ID || !N8N_WEBHOOK) {
  console.error('Missing required environment variables:');
  if (!DISCORD_TOKEN) console.error('  - DISCORD_TOKEN');
  if (!BOT_USER_ID) console.error('  - BOT_USER_ID');
  if (!N8N_WEBHOOK) console.error('  - N8N_WEBHOOK');
  process.exit(1);
}

const clientIntents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.MessageContent,
];

// Role-member DMs for escalation need the (privileged) Server Members Intent.
// Only requested when escalation is on, so default boot behavior is unchanged.
if (isEscalationEnabled()) {
  clientIntents.push(GatewayIntentBits.GuildMembers);
}

const client = new Client({
  intents: clientIntents,
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
});

client.on(Events.ShardDisconnect, (event, shardId) => {
  const code = event?.code ?? 'unknown';
  console.warn(`[gateway] shard ${shardId} disconnected (code ${code}) — bot may appear offline until reconnect`);
  scheduleGatewayRecovery('disconnect');
});

client.on(Events.ShardReconnecting, (shardId) => {
  console.warn(`[gateway] shard ${shardId} reconnecting…`);
  scheduleGatewayRecovery('reconnecting');
});

client.on(Events.ShardReady, (shardId, unavailableGuilds) => {
  clearGatewayRecoveryTimer();
  const extra = unavailableGuilds?.size ? ` (${unavailableGuilds.size} guilds unavailable)` : '';
  console.log(`[gateway] shard ${shardId} ready${extra}`);
});

let gatewayRecoveryTimer = null;
let gatewayRecoveryInFlight = false;

function clearGatewayRecoveryTimer() {
  if (gatewayRecoveryTimer) {
    clearTimeout(gatewayRecoveryTimer);
    gatewayRecoveryTimer = null;
  }
}

function scheduleGatewayRecovery(reason) {
  clearGatewayRecoveryTimer();
  const delayMs = Number(process.env.GATEWAY_RECOVERY_MS || 90_000);
  gatewayRecoveryTimer = setTimeout(() => {
    attemptGatewayRecovery(reason).catch((error) => {
      console.error('[gateway] recovery failed:', error.message);
    });
  }, delayMs);
}

async function attemptGatewayRecovery(reason) {
  if (gatewayRecoveryInFlight || client.isReady()) return;

  gatewayRecoveryInFlight = true;
  console.warn(`[gateway] still offline after disconnect (${reason}) — forcing full reconnect`);

  try {
    client.destroy();
  } catch {
    // ignore destroy errors on dead connection
  }

  try {
    await client.login(DISCORD_TOKEN);
    console.log('[gateway] full reconnect succeeded');
  } finally {
    gatewayRecoveryInFlight = false;
  }
}

async function registerSlashCommandsForGuild(rest, applicationId, guildId, commands) {
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: commands });
  console.log(`Registered ${getSlashCommandNamesLine()} in guild ${guildId}`);
}

async function registerSlashCommands(applicationId, guildIds = []) {
  const commands = buildSlashCommandsPayload();
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  // Clear global commands first — stale global + guild copies cause Discord UI glitches
  // (stacked duplicate option fields that cannot be submitted).
  await rest.put(Routes.applicationCommands(applicationId), { body: [] });

  const uniqueGuildIds = [...new Set(guildIds.filter(Boolean))];
  if (!uniqueGuildIds.length) {
    console.warn('[slash] no guilds to register — invite the bot to a server or set DISCORD_GUILD_ID');
    return;
  }

  for (const guildId of uniqueGuildIds) {
    await registerSlashCommandsForGuild(rest, applicationId, guildId, commands);
  }
  console.log(`[slash] registered in ${uniqueGuildIds.length} guild(s) (global commands cleared)`);
}

function collectGuildIdsForSlashRegistration() {
  const fromClient = [...client.guilds.cache.keys()];
  const extras = parseExtraGuildIds();
  const primary = DISCORD_GUILD_ID ? [DISCORD_GUILD_ID] : [];
  return [...new Set([...fromClient, ...extras, ...primary])];
}

function parseExtraGuildIds() {
  const raw = process.env.DISCORD_GUILD_IDS || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function formatForDiscord(text, issueUrl) {
  if (!text) return text;

  // Convert legacy markdown links to bold label + bare URL (Discord auto-links bare URLs).
  let out = text.replace(/\*\*\[([^\]]+)\]\((https?:\/\/[^)]+)\)\*\*/g, '**$1**\n$2');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '**$1**\n$2');

  // Ensure issue URL is on its own line if we have one and it's missing.
  if (issueUrl && !out.includes(issueUrl)) {
    out = `${out.trim()}\n${issueUrl}`;
  }

  return out;
}

function extractReplyText(responseData, responseText) {
  if (responseData) {
    const raw =
      responseData?.message ||
      responseData?.data?.content ||
      (typeof responseData?.content === 'string' ? responseData.content : null);

    if (raw) return formatForDiscord(raw, responseData?.issueUrl);
  }

  if (responseText && responseText.trim()) {
    try {
      const parsed = JSON.parse(responseText);
      return extractReplyText(parsed);
    } catch {
      return formatForDiscord(responseText.trim());
    }
  }

  return null;
}

function applyN8nSideEffects(userId, responseData, meta = {}) {
  if (!responseData || !userId) return;

  if (responseData.clearPendingPlan) {
    pendingPlans.clear(userId);
    console.log(`[plan] cleared for user ${userId}`);
  }

  if (responseData.pendingPlan) {
    pendingPlans.set(userId, responseData.pendingPlan, meta);
    console.log(`[plan] stored for user ${userId}: ${responseData.pendingPlan.summary || responseData.pendingPlan.id}`);
  }
}

function buildBasePayload({ content, channelId, user, source }) {
  const payload = {
    type: source === 'slash' ? 2 : 0,
    content,
    channel_id: channelId,
    member: {
      user: {
        id: user.id,
        username: user.username,
      },
    },
    user: {
      id: user.id,
      username: user.username,
    },
    source,
  };

  if (source === 'slash') {
    payload.data = {
      options: [{ name: 'command', value: content }],
    };
  }

  return payload;
}

function resolveOutboundPayload({ content, channelId, user, source }) {
  const kind = pendingPlans.classifyCommand(content);

  if (kind === 'cancel') {
    const had = pendingPlans.has(user.id);
    pendingPlans.clear(user.id);
    return {
      localReply: had
        ? 'Plan cancelled.'
        : 'No pending plan to cancel.',
    };
  }

  if (kind === 'status') {
    const entry = pendingPlans.get(user.id);
    return {
      localReply: entry
        ? pendingPlans.formatSummary(entry)
        : 'No pending plan. Try: `plan fix ENG-11 in my-repo`',
    };
  }

  if (kind === 'execute') {
    const entry = pendingPlans.get(user.id);
    if (!entry) {
      return {
        localReply: 'No pending plan. Ask for a plan first, e.g. `plan fix ENG-11`.',
      };
    }

    return {
      localExecute: {
        plan: entry.plan,
        meta: { channelId, username: user.username },
      },
    };
  }

  const salesParsed = parseSalesSupportCommand(content);
  if (salesParsed) {
    return { localSalesSupport: salesParsed };
  }

  const commitParsed = parseCommitSummaryCommand(content);
  if (commitParsed) {
    return { localCommitSummary: commitParsed };
  }

  const entry = pendingPlans.get(user.id);
  return {
    payload: {
      ...buildBasePayload({ content, channelId, user, source }),
      has_pending_plan: !!entry,
    },
  };
}

async function handleN8nCommand({
  content, channelId, user, source, reply, sendFollowUp, resolveMainMessage,
}) {
  const resolved = resolveOutboundPayload({ content, channelId, user, source });
  const followUp = sendFollowUp || reply;

  if (resolved.localReply) {
    await reply(resolved.localReply);
    return;
  }

  if (resolved.localSalesSupport) {
    const parsed = resolved.localSalesSupport;
    const isDirect = !!parsed.repoHint;

    try {
      if (isDirect) await reply('⏳ Ετοιμασία ενημερωτικού πωλήσεων & υποστήριξης…');

      const response = await startSalesSupportFlow({
        userId: user.id,
        parsed,
      });

      if (response.components?.length) {
        await reply({
          content: response.content,
          components: response.components,
        });
        return;
      }

      const sendExtra = (content) => followUp(content);
      const sendMain = async (content) => {
        const msg = await (isDirect ? followUp : reply)(content);
        if (msg?.id) return msg;
        if (resolveMainMessage) return resolveMainMessage();
        return msg;
      };

      await deliverSalesSupportResult({
        result: response,
        userId: user.id,
        sendMain,
        sendExtra,
        resolveMainMessage,
      });
    } catch (error) {
      console.error('[sales-support] failed:', error);
      await reply(`❌ ${error.message || 'Αποτυχία ενημερωτικού πωλήσεων & υποστήριξης.'}`);
    }
    return;
  }

  if (resolved.localCommitSummary) {
    const parsed = resolved.localCommitSummary;
    const isDirect = !!(parsed.repoHint && parsed.branchHint);

    try {
      if (isDirect) await reply('⏳ Reviewing latest commit…');

      const response = await startCommitSummaryFlow({
        userId: user.id,
        parsed,
      });

      if (response.components?.length) {
        await reply({
          content: response.content,
          components: response.components,
        });
        return;
      }

      const deliver = isDirect ? followUp : reply;
      await deliver(response.content);
      for (const extra of response.extraMessages || []) {
        await followUp(extra);
      }
    } catch (error) {
      console.error('[commit-summary] failed:', error);
      await reply(`❌ ${error.message || 'Commit summary failed.'}`);
    }
    return;
  }

  if (resolved.localExecute) {
    const { plan } = resolved.localExecute;
    await reply('🚀 Starting — scanning repo, generating AI edits, opening PR…');

    try {
      const result = await executePlan(plan, {
        onProgress: async (status) => {
          console.log(`[execute] ${status}`);
          if (source === 'slash') await reply(status);
        },
      });

      pendingPlans.clear(user.id);
      console.log(`[execute] PR opened: ${result.prUrl}`);
      await reply(result.message);
    } catch (error) {
      console.error('[execute] failed:', error);
      await reply(`❌ ${error.message || 'Plan execution failed.'}`);
    }
    return;
  }

  const { ok, status, responseText, responseData } = await forwardToN8n(resolved.payload);

  if (!ok) {
    console.error(`n8n webhook failed (${status}): ${responseText}`);
    await reply('Something went wrong talking to n8n. Check the bridge logs.');
    return;
  }

  applyN8nSideEffects(user.id, responseData, {
    channelId,
    username: user.username,
  });

  const replyText = extractReplyText(responseData, responseText);
  if (!replyText) {
    console.error('n8n returned empty body:', responseText || '(empty)');
    await reply('n8n ran but returned no message. Check n8n executions.');
    return;
  }

  await reply(replyText);
}

async function forwardToN8n(payload) {
  const response = await fetch(N8N_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let responseData = null;

  try {
    responseData = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseData = null;
  }

  return { ok: response.ok, status: response.status, responseText, responseData };
}

client.once('ready', async () => {
  const pm2Info = process.env.pm_id != null ? ` | PM2 id ${process.env.pm_id}` : '';
  console.log(`Logged in as ${client.user.tag} (${client.user.id})${pm2Info}`);
  console.log(`DMs: on | Slash: ${getSlashCommandNamesLine()} | Guilds: ${client.guilds.cache.size} | Mentions: ${DM_ONLY ? 'off' : 'on'} | Plan memory: on | Commit summary: on | GitHub execute: ${githubExecuteStatus()} | Auto commit review: ${commitReviewStatus()}`);
  console.log(`Knowledge: ${knowledgeStatus()}`);
  console.log(`Escalation: ${escalationStatus()}`);
  console.log(`Codebase brief: ${codebaseBriefStatus()}`);
  console.log(`Thread cleanup: ${cleanupStatus()}`);
  console.log(`Forwarding to: ${N8N_WEBHOOK}`);

  const webhook = createWebhookServer({ discordClient: client });
  webhook.start();

  startAutoCommitReview(client);
  startEscalation(client);
  startCodebaseBriefScheduler(client);
  startKnowledgeReindexWatcher();
  startAssistantThreadCleanupScheduler(client);

  if (!DISCORD_GUILD_ID) {
    console.warn('Tip: set DISCORD_GUILD_ID in .env for primary-server features (commit summary channel, escalation bind)');
  }

  try {
    await client.application.fetch();
    await registerSlashCommands(client.application.id, collectGuildIdsForSlashRegistration());
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }
});

client.on('guildCreate', async (guild) => {
  try {
    await client.application.fetch();
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    await registerSlashCommandsForGuild(
      rest,
      client.application.id,
      guild.id,
      buildSlashCommandsPayload(),
    );
    console.log(`[slash] joined guild "${guild.name}" (${guild.id}) — commands registered`);
  } catch (error) {
    console.error(`[slash] failed to register commands in guild ${guild.id}:`, error.message);
  }
});

async function safeDeferReply(interaction, options = {}) {
  if (interaction.deferred || interaction.replied) return true;
  try {
    await interaction.deferReply(options);
    return true;
  } catch (error) {
    console.error('[interaction] deferReply failed:', error.message);
    return false;
  }
}

async function respondInteractionError(interaction, message) {
  const payload = { content: message, components: [] };
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply({ ...payload, ephemeral: true });
    }
  } catch (error) {
    console.error('[interaction] could not send error response:', error.message);
  }
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isStringSelectMenu()) {
      if (await handleSalesSupportSelect(interaction)) return;
      if (await handleGitHubIssueSelect(interaction)) return;
      if (await handleCommitSummarySelect(interaction)) return;
      if (await handleDevSelect(interaction)) return;
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({
          content: 'This menu expired. Run the slash command again.',
          ephemeral: true,
        }).catch(() => {});
      }
      return;
    }

    if (interaction.isButton()) {
      // Deploy PROD buttons are handled by awaitMessageComponent inside handleDeployCommand.
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({
          content: 'This button expired. Run `/deploy` again.',
          ephemeral: true,
        }).catch(() => {});
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'help') {
      await interaction.deferReply();
      const hub = await createHubSession(interaction);
      const parts = buildHelpMessages();
      await hub.sendMain(parts[0]);
      for (const part of parts.slice(1)) {
        await hub.sendFollowUp(part);
      }
      return;
    }

    if (interaction.commandName === 'n8n-linear') {
      if (!await safeDeferReply(interaction)) return;

      try {
        const commandText = interaction.options.getString('command', true).trim();
        if (!commandText) {
          await interaction.editReply('Please provide a command.');
          return;
        }

        console.log(`[slash] ${interaction.user.username} in #${interaction.channel?.name || 'dm'}: ${commandText}`);

        const hub = await createHubSession(interaction);
        await hub.sendLoading('⏳ Επεξεργασία εντολής…');

        await handleN8nCommand({
          content: commandText,
          channelId: interaction.channelId,
          user: { id: interaction.user.id, username: interaction.user.username },
          source: 'slash',
          reply: (payload) => {
            if (typeof payload === 'string') return hub.sendMain(payload);
            return hub.sendMain({
              content: payload.content,
              components: payload.components ?? [],
            });
          },
          sendFollowUp: (text) => hub.sendFollowUp(text),
          resolveMainMessage: () => hub.fetchMainMessage(),
        });
        console.log('Slash command handled');
      } catch (error) {
        console.error('Failed to handle slash command:', error);
        await interaction.editReply('Could not reach n8n. Is the workflow active?').catch(() => {});
      }
      return;
    }

    if (interaction.commandName === 'deploy') {
      console.log(`[deploy] ${interaction.user.username} in #${interaction.channel?.name || 'dm'}: type=${interaction.options.getString('type')} branch=${interaction.options.getString('branch') || '(auto)'}`);
      try {
        await handleDeployCommand(interaction);
      } catch (err) {
        console.error('[deploy] Unhandled error:', err);
        await respondInteractionError(interaction, '❌ Something went wrong. Check the bridge logs.');
      }
      return;
    }

    if (interaction.commandName === 'sales-support') {
      if (!await safeDeferReply(interaction)) return;

      const question = interaction.options.getString('question');
      console.log(
        `[sales-support] ${interaction.user.username} in #${interaction.channel?.name || 'dm'}: `
        + `question=${question ? 'yes' : 'default'}`,
      );

      try {
        const hub = await createHubSession(interaction);
        await handleSalesSupportInteraction(interaction, hub);
      } catch (error) {
        console.error('[sales-support] slash failed:', error);
        await interaction.editReply('❌ Sales support briefing failed. Check bridge logs.').catch(() => {});
      }
      return;
    }

    if (interaction.commandName === 'app-status') {
      if (!await safeDeferReply(interaction)) return;

      const question = interaction.options.getString('question') || '';
      console.log(`[app-status] ${interaction.user.username}: ${question ? question.slice(0, 60) : '(default)'}`);

      try {
        const hub = await createHubSession(interaction);
        await hub.sendLoading('⏳ Building app status…');
        const result = await runAppStatusAssistant({ question, repoFullName: GITHUB_REPO });
        await deliverAppStatusResult({ interaction, result, hubSession: hub });
      } catch (error) {
        console.error('[app-status] slash failed:', error);
        await interaction.editReply(`❌ ${error.message || 'App status failed.'}`).catch(() => {});
      }

      return;
    }

    if (interaction.commandName === 'github-issue') {
      if (!await safeDeferReply(interaction)) return;

      const title = interaction.options.getString('title', true);
      const description = interaction.options.getString('description');
      const issueType = interaction.options.getString('type');
      const labels = interaction.options.getString('labels');

      console.log(
        `[github-issue] ${interaction.user.username}: repo=EmblemTameiaki title=${truncateForLog(title)}`
        + ` type=${issueType || 'auto'}`,
      );

      try {
        const hub = await createHubSession(interaction);
        await hub.sendLoading('⏳ Translating to English & classifying issue (bug / feature / task)…');
        const result = await startGitHubIssueFlow({
          userId: interaction.user.id,
          username: interaction.user.username,
          title,
          description,
          typeRaw: issueType,
          labelsRaw: labels,
        });

        await hub.sendMain({
          content: result.content,
          components: result.components ?? [],
        });
      } catch (error) {
        console.error('[github-issue] slash failed:', error);
        await interaction.editReply(`❌ ${error.message}`).catch(() => {});
      }
      return;
    }

    if (interaction.commandName === 'dev') {
      if (!await safeDeferReply(interaction)) return;

      const question = interaction.options.getString('question', true);
      console.log(`[dev] ${interaction.user.username}: repo=EmblemTameiaki question=${truncateForLog(question)}`);

      try {
        const hub = await createHubSession(interaction);
        await hub.sendLoading('⏳ Ετοιμασία dev plan…');
        const result = await startDevAssistantFlow({
          userId: interaction.user.id,
          question,
        });

        if (result.components?.length) {
          await hub.sendMain({
            content: result.content,
            components: result.components,
          });
          return;
        }

        await deliverDevResult(interaction, result, hub);
      } catch (error) {
        console.error('[dev] slash failed:', error);
        await interaction.editReply(`❌ ${error.message}`).catch(() => {});
      }
      return;
    }

    if (interaction.commandName === 'leads') {
      if (!await safeDeferReply(interaction)) return;

      const question = interaction.options.getString('question', true);
      console.log(`[leads] ${interaction.user.username}: ${truncateForLog(question)}`);

      try {
        const hub = await createHubSession(interaction);
        await handleLeadsInteraction(interaction, hub);
      } catch (error) {
        console.error('[leads] slash failed:', error);
        await interaction.editReply(`❌ ${error.message || 'Leads lookup failed.'}`).catch(() => {});
      }
      return;
    }

    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({
        content: `Unknown command. Try \`/help\` for a full list (${getSlashCommandNamesLine()}).`,
        ephemeral: true,
      }).catch(() => {});
    }
  } catch (error) {
    console.error('[interaction] unhandled error:', error);
    await respondInteractionError(interaction, '❌ Something went wrong. Check the bridge logs.');
  }
});

function truncateForLog(text, max = 80) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.author.id === BOT_USER_ID) return;

  const isDM = message.channel.isDMBased();

  // Source follow-ups work in server channels too (reply to bot sales-support message).
  if (await tryHandleSalesSupportSourceReply(message, BOT_USER_ID)) {
    console.log(`[sales-support] source reply from ${message.author.username}`);
    return;
  }

  // Passive knowledge capture: raw log of designated support channels.
  if (isCaptureEnabled() && !isDM) {
    try {
      if (captureMessage(message)) {
        console.log(`[capture] logged message in #${message.channel?.name || message.channel?.id}`);
      }
    } catch (error) {
      console.error('[capture] failed to log message:', error.message);
    }
  }

  // Auto-escalation: track unanswered questions in watched channels/threads.
  if (isEscalationEnabled() && !isDM) {
    try {
      handleChannelMessageWithHint(message);
    } catch (error) {
      console.error('[escalation] failed to track message:', error.message);
    }
  }

  // "kb save" reply command promotes a solved thread into curated knowledge.
  if (/^kb\s+save\b/i.test(message.content.trim())) {
    try {
      const handled = await handleKbSaveCommand(message, { client });
      if (handled) return;
    } catch (error) {
      console.error('[kb-save] failed:', error.message);
      await message.reply('Δεν μπόρεσα να αποθηκεύσω τη λύση. Δες τα logs.');
      return;
    }
  }

  const isMention = message.mentions.users.has(BOT_USER_ID);
  const rawContent = message.content.trim();
  const appParsed = parseAppStatusCommand(rawContent);

  if (DM_ONLY && !isDM && !appParsed) return;
  if (!DM_ONLY && !isDM && !isMention && !appParsed) return;

  let content = rawContent;
  if (!isDM && isMention) {
    content = content.replace(new RegExp(`<@!?${BOT_USER_ID}>\\s*`, 'g'), '').trim();
  }

  if (!content) return;

  if (appParsed) {
    try {
      const progressMsg = await message.reply('⏳ Building app status…');
      const result = await runAppStatusAssistant({
        question: appParsed.question,
        repoFullName: GITHUB_REPO,
      });
      await deliverAppStatusResult({ message, progressMessage: progressMsg, result });
    } catch (error) {
      console.error('[app-status] message failed:', error);
      await message.reply(`❌ ${error.message || 'App status failed.'}`);
    }
    return;
  }

  console.log(`[${isDM ? 'DM' : 'mention'}] ${message.author.username}: ${content}`);

  try {
    await handleN8nCommand({
      content,
      channelId: message.channel.id,
      user: { id: message.author.id, username: message.author.username },
      source: isDM ? 'dm' : 'mention',
      reply: (payload) => {
        if (typeof payload === 'string') return message.reply(payload);
        return message.reply({
          content: payload.content,
          components: payload.components,
        });
      },
      sendFollowUp: (text) => message.channel.send(text),
    });
    console.log('Message handled');
  } catch (error) {
    console.error('Failed to handle message:', error);
    await message.reply('Could not reach n8n. Is the workflow active and the webhook URL correct?');
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  try {
    // Resolved-emoji clears a tracked escalation question.
    if (handleEscalationResolved(reaction, user)) return;
    // Approval in the review channel opens the wiki PR.
    if (await handleReviewApprovalReaction(reaction, user, { client })) return;
    // Solve emoji in a capture channel promotes the thread into knowledge.
    await handleSolveReaction(reaction, user, { client });
  } catch (error) {
    console.error('Failed to handle reaction:', error);
  }
});

client.login(DISCORD_TOKEN);
