/**
 * In-memory pending plan store (per Discord user).
 * Lost on bridge restart — by design for v1.
 */

const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** @type {Map<string, { plan: object, createdAt: number, expiresAt: number, channelId?: string, username?: string }>} */
const store = new Map();

function getTtlMs() {
  const minutes = Number(process.env.PLAN_TTL_MINUTES || 30);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : DEFAULT_TTL_MS;
}

function set(userId, plan, meta = {}) {
  const now = Date.now();
  store.set(userId, {
    plan,
    createdAt: now,
    expiresAt: now + getTtlMs(),
    channelId: meta.channelId,
    username: meta.username,
  });
}

function get(userId) {
  const entry = store.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(userId);
    return null;
  }
  return entry;
}

function clear(userId) {
  store.delete(userId);
}

function has(userId) {
  return get(userId) !== null;
}

function formatSummary(entry) {
  const plan = entry.plan || {};
  const lines = [
    '📋 **Pending plan**',
    plan.summary ? `**${plan.summary}**` : null,
    plan.issueIdentifier ? `Linear: **${plan.issueIdentifier}**` : null,
    plan.issueUrl || null,
    plan.planDocUrl ? `Plan doc: ${plan.planDocUrl}` : null,
    plan.githubIssueUrl ? `GitHub issue: ${plan.githubIssueUrl}` : null,
    plan.repo ? `Repo: \`${plan.repo}\`` : null,
    plan.branch ? `Branch: \`${plan.branch}\`` : null,
    plan.steps?.length ? `\n**Steps:**\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : null,
    `\nReply **go** to open a PR · **cancel** to discard · expires in ${Math.max(1, Math.round((entry.expiresAt - Date.now()) / 60000))}m`,
  ].filter(Boolean);

  return lines.join('\n');
}

const EXECUTE_PATTERN = /^(go|yes|approve|ship it|do it|lgtm)\.?$/i;
const CANCEL_PATTERN = /^(cancel|abort|nevermind|never mind|discard)\.?$/i;
const STATUS_PATTERN = /^(plan|pending|status)(\s+plan)?\.?$/i;

function classifyCommand(text) {
  const trimmed = text.trim();
  if (EXECUTE_PATTERN.test(trimmed)) return 'execute';
  if (CANCEL_PATTERN.test(trimmed)) return 'cancel';
  if (STATUS_PATTERN.test(trimmed)) return 'status';
  return 'forward';
}

module.exports = {
  set,
  get,
  clear,
  has,
  formatSummary,
  classifyCommand,
};
