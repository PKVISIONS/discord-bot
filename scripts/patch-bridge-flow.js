#!/usr/bin/env node
/**
 * Add bridge plan protocol + GitHub list repos + plan/execute stubs to n8n workflow.
 * Run after: node scripts/patch-workflow.js
 */
require('dotenv').config({ override: true });

const { formatPlanMarkdown } = require('../lib/plan-document');
const {
  formatGitHubIssueBody,
  githubIssueTitle,
} = require('../lib/github-plan-issue');

const WORKFLOW_ID = 'fxxutl0HMJbv3p4G';
const LINEAR_WORKSPACE = process.env.LINEAR_WORKSPACE || 'techflowlabs';
const GITHUB_ORG = process.env.GITHUB_ORG || 'TechFlow-Labs';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const LINEAR_CRED = { httpHeaderAuth: { id: 'NTfExkZEVJ06lSX7', name: 'HyperFrames API' } };

if (!GITHUB_TOKEN) {
  console.error('GITHUB_TOKEN missing from .env');
  process.exit(1);
}

const EXTRACT_MESSAGE_CODE = `const root = $input.first().json;
let body = root.body || root;

// Unwrap nested webhook bodies (n8n sometimes double-wraps JSON).
while (body && body.body && !body.content && !(body.data && body.data.options) && !body.bridge_action) {
  body = body.body;
}

let userMessage = '';
let channelId = '';
let userId = '';
let username = '';

if (body.bridge_action === 'execute_plan') {
  userMessage = body.content || 'go';
} else if (body.data && body.data.options) {
  const textOption = body.data.options.find((o) => o.name === 'command');
  userMessage = textOption ? textOption.value : '';
} else if (body.content) {
  userMessage = body.content.replace(/<@!?\\d+>\\s*/g, '').trim();
}

if (!userMessage && typeof body.content === 'string') {
  userMessage = body.content.trim();
}

channelId = body.channel_id || body.channel?.id || '';
userId = body.member?.user?.id || body.user?.id || '';
username = body.member?.user?.username || body.user?.username || 'Unknown';

return [{
  json: {
    userMessage,
    channelId,
    userId,
    username,
    source: body.source || 'discord',
    rawBody: body,
    bridgeAction: body.bridge_action || null,
    pendingPlan: body.pending_plan || null,
    hasPendingPlan: !!body.has_pending_plan,
  }
}];`;

const PARSE_AI_EXTRA = `const item = $input.first().json;
const aiResponse = item.text || item.content?.[0]?.text || item.message?.content || '';

let parsed;
try {
  const clean = aiResponse.replace(/\`\`\`json\\n?|\`\`\`/g, '').trim();
  parsed = JSON.parse(clean);
} catch {
  parsed = {
    action: 'error',
    error: 'Could not parse command.',
  };
}

const original = $('Extract Message').first().json;

return [{
  json: {
    ...parsed,
    userMessage: original.userMessage,
    channelId: original.channelId,
    userId: original.userId,
    username: original.username,
    hasPendingPlan: original.hasPendingPlan,
  }
}];`;

const AI_SYSTEM_APPEND = `

GitHub actions (org: ${GITHUB_ORG}):
- list_repos: List organization repositories
- plan_github: Draft an implementation plan from a Linear issue (requires issue_id; optional repo hint in params.repo)
- summarize_issue: Summarize a Linear issue (requires issue_id)
- execute_plan: (bridge only — do not emit from natural language)

For summarize_issue: { "action": "summarize_issue", "params": { "issue_id": "ENG-123" } }

For plan_github return:
{
  "action": "plan_github",
  "params": {
    "issue_id": "ENG-123",
    "repo": "optional-repo-name",
    "summary": "short title",
    "steps": ["step 1", "step 2"]
  }
}

For list_repos: { "action": "list_repos", "params": {} }`;

const FORMAT_REPOS_CODE = `const first = $input.first().json;
const repos = Array.isArray(first)
  ? first
  : $input.all().map((item) => item.json).filter((r) => r && r.name);
const top = repos
  .filter((r) => !r.archived)
  .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
  .slice(0, 15);

if (!top.length) {
  return [{ json: { message: '🔍 No repositories found.' } }];
}

const lines = top.map((r) => {
  const lang = r.language ? \` · \${r.language}\` : '';
  return \`• **\${r.name}**\${lang}\\n  └ \${r.html_url}\`;
}).join('\\n\\n');

return [{
  json: {
    message: \`📦 **${GITHUB_ORG} repos** (showing \${top.length}):\\n\\n\${lines}\`,
  }
}];`;

const BUILD_PLAN_CODE = `const issueResult = $input.first().json;
const shortcut = $('Command Shortcuts').first().json;
const action = shortcut.action === 'plan_github'
  ? shortcut
  : $('Parse AI Response').first().json;
const params = action?.params || {};

const issue = issueResult.data?.issues?.nodes?.[0];
if (!issue) {
  return [{ json: { message: \`❌ Issue "\${params.issue_id || 'unknown'}" not found.\` } }];
}

const planId = \`plan_\${Date.now()}\`;
const repo = params.repo || 'TBD';
const branch = \`fix/\${issue.identifier.toLowerCase()}-\${(params.summary || issue.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}\`;

const steps = params.steps?.length
  ? params.steps
  : [
      'Inspect relevant files in the repo',
      'Apply the fix described in the Linear issue',
      'Open a pull request for review',
    ];

const pendingPlan = {
  id: planId,
  summary: params.summary || issue.title,
  issueId: issue.id,
  issueIdentifier: issue.identifier,
  issueUrl: issue.url,
  issueTitle: issue.title,
  issueDescription: (issue.description || '').trim(),
  repo,
  branch,
  prTitle: \`[\${issue.identifier}] \${params.summary || issue.title}\`,
  prBody: \`Fixes \${issue.identifier}\\n\\n\${issue.url}\\n\\n## Plan\\n\${steps.map((s, i) => \`\${i + 1}. \${s}\`).join('\\n')}\`,
  steps,
  createdBy: action?.username || 'Unknown',
};

return [{ json: { pendingPlan } }];`;

const PLAN_FORMAT_FN = formatPlanMarkdown.toString();

const PLAN_FORMAT_DOCUMENT_CODE = `const built = $input.first().json;
const pendingPlan = built.pendingPlan;
${PLAN_FORMAT_FN}
const markdown = formatPlanMarkdown(pendingPlan);
const documentTitle = \`AI Plan — \${pendingPlan.issueIdentifier}\`;
return [{ json: { pendingPlan, markdown, documentTitle } }];`;

const PLAN_FINALIZE_CODE = `const doc = $('Plan: Format Document').first().json;
const linear = $('Linear: Create Plan Document').first().json;
const githubIssue = $('GitHub: Create Plan Issue').first().json;

const created = linear?.data?.documentCreate;
const planDoc = created?.document;
const planDocUrl = planDoc?.url
  || (planDoc?.slugId ? 'https://linear.app/${LINEAR_WORKSPACE}/document/' + planDoc.slugId : null);
const linearDocCreated = created?.success === true && !!planDocUrl;

const pendingPlan = {
  ...doc.pendingPlan,
  planDocUrl,
  linearDocumentId: planDoc?.id || null,
  githubIssueNumber: githubIssue?.githubIssueNumber || null,
  githubIssueUrl: githubIssue?.githubIssueUrl || null,
};

const repo = pendingPlan.repo;
const steps = pendingPlan.steps || [];

const message = [
  '📋 **Plan ready — review before I code**',
  \`**\${pendingPlan.summary}**\`,
  \`Linear: **\${pendingPlan.issueIdentifier}** — \${pendingPlan.issueTitle}\`,
  pendingPlan.issueUrl,
  planDocUrl ? \`Plan doc: \${planDocUrl}\` : null,
  pendingPlan.githubIssueUrl ? \`GitHub issue: \${pendingPlan.githubIssueUrl}\` : null,
  \`Repo: \\\`\${repo}\\\` · Branch: \\\`\${pendingPlan.branch}\\\`\`,
  '',
  '**Steps:**',
  ...steps.map((s, i) => \`\${i + 1}. \${s}\`),
  '',
  linearDocCreated
    ? '_Plan saved as a Linear document on the issue (Resources)._'
    : '_Plan doc could not be saved in Linear._',
  pendingPlan.githubIssueUrl
    ? '_GitHub tracking issue created — review there before **go**._'
    : (repo === 'TBD' ? null : '_GitHub issue could not be created._'),
  repo === 'TBD'
    ? '⚠️ No repo specified — re-plan with: \`plan fix ENG-11 in repo-name\`'
    : 'Reply **go** to run AI edits and open a PR (links GitHub issue).',
  'Reply **cancel** to discard.',
].filter(Boolean).join('\\n');

return [{
  json: {
    message,
    pendingPlan,
    issueUrl: pendingPlan.issueUrl,
    planDocUrl,
    githubIssueUrl: pendingPlan.githubIssueUrl,
  }
}];`;

const GITHUB_ISSUE_BODY_FN = formatGitHubIssueBody.toString();
const GITHUB_ISSUE_TITLE_FN = githubIssueTitle.toString();

const GITHUB_CREATE_ISSUE_CODE = `const doc = $('Plan: Format Document').first().json;
const linear = $('Linear: Create Plan Document').first().json;
const planDoc = linear?.data?.documentCreate?.document;
const planDocUrl = planDoc?.url
  || (planDoc?.slugId ? 'https://linear.app/${LINEAR_WORKSPACE}/document/' + planDoc.slugId : null);

const plan = {
  ...doc.pendingPlan,
  planDocUrl,
  linearDocumentId: planDoc?.id || null,
};

${GITHUB_ISSUE_TITLE_FN}
${GITHUB_ISSUE_BODY_FN}

if (!plan.repo || plan.repo === 'TBD') {
  return [{ json: { pendingPlan: plan, githubIssueNumber: null, githubIssueUrl: null, skipped: true } }];
}

const org = '${GITHUB_ORG}';
const token = '${GITHUB_TOKEN}';
const headers = {
  Authorization: \`Bearer \${token}\`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

const searchQ = encodeURIComponent(\`repo:\${org}/\${plan.repo} is:issue is:open \${plan.issueIdentifier} in:title\`);
let existing = null;
try {
  const search = await this.helpers.httpRequest({
    method: 'GET',
    url: \`https://api.github.com/search/issues?q=\${searchQ}\`,
    headers,
    json: true,
    ignoreHttpStatusErrors: true,
  });
  existing = (search.items || []).find((item) => item.title?.includes(\`[\${plan.issueIdentifier}]\`)) || null;
} catch {}

if (existing) {
  return [{
    json: {
      pendingPlan: {
        ...plan,
        githubIssueNumber: existing.number,
        githubIssueUrl: existing.html_url,
      },
      githubIssueNumber: existing.number,
      githubIssueUrl: existing.html_url,
      created: false,
    },
  }];
}

let created = await this.helpers.httpRequest({
  method: 'POST',
  url: \`https://api.github.com/repos/\${org}/\${plan.repo}/issues\`,
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: {
    title: githubIssueTitle(plan),
    body: formatGitHubIssueBody(plan),
    labels: ['linear-bot'],
  },
  json: true,
  ignoreHttpStatusErrors: true,
});

if (!created.number && created.message) {
  created = await this.helpers.httpRequest({
    method: 'POST',
    url: \`https://api.github.com/repos/\${org}/\${plan.repo}/issues\`,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: {
      title: githubIssueTitle(plan),
      body: formatGitHubIssueBody(plan),
    },
    json: true,
    ignoreHttpStatusErrors: true,
  });
}

if (!created.number) {
  return [{
    json: {
      pendingPlan: plan,
      githubIssueNumber: null,
      githubIssueUrl: null,
      skipped: true,
      reason: created.message || 'create_failed',
    },
  }];
}

return [{
  json: {
    pendingPlan: {
      ...plan,
      githubIssueNumber: created.number,
      githubIssueUrl: created.html_url,
    },
    githubIssueNumber: created.number,
    githubIssueUrl: created.html_url,
    created: true,
  },
}];`;

const EXECUTE_PLAN_CODE = `const action = $input.first().json;
const plan = action.params?.plan;

if (!plan) {
  return [{ json: { message: '❌ No pending plan found. Ask for a plan first, e.g. \`plan fix ENG-11\`.', clearPendingPlan: true } }];
}

return [{
  json: {
    message: 'ℹ️ Plan execution runs in the Discord bridge (not n8n). Reply **go** from the same machine running `npm start` with GITHUB_TOKEN and OPENAI_API_KEY set.',
    clearPendingPlan: false,
  }
}];`;

const FORMAT_ISSUE_SUMMARY_CODE = `const result = $input.first().json;
const issue = result.data?.issues?.nodes?.[0];

if (!issue) {
  return [{ json: { message: '❌ Issue not found. Use format like ENG-10.' } }];
}

const priorityLabel = { 0: 'None', 1: '🔴 Urgent', 2: '🟠 High', 3: '🟡 Medium', 4: '🔵 Low' };
const labels = (issue.labels?.nodes || []).map((l) => l.name).join(', ') || 'none';
const desc = (issue.description || '').trim() || '_No description_';

const message = [
  \`📄 **\${issue.identifier}** — \${issue.title}\`,
  issue.url,
  '',
  \`**Status:** \${issue.state?.name || 'Unknown'}\`,
  \`**Assignee:** \${issue.assignee?.name || 'Unassigned'}\`,
  \`**Priority:** \${priorityLabel[issue.priority] ?? 'None'}\`,
  \`**Labels:** \${labels}\`,
  '',
  '**Description:**',
  desc,
].join('\\n');

return [{ json: { message, issueUrl: issue.url } }];`;

const HANDLE_UNKNOWN_CODE = `const action = $json.action;

// Actions handled by dedicated IF branches — stop here without duplicating work.
const routedElsewhere = new Set([
  'create_issue', 'update_status', 'assign_issue', 'search_issues',
  'list_repos', 'plan_github', 'execute_plan', 'summarize_issue',
]);

if (routedElsewhere.has(action)) {
  return [];
}

if (action === 'error') {
  return [{ json: { message: \`❌ \${$json.error || 'Could not parse command.'}\` } }];
}

if (action === 'clarification_needed' || $json.clarification_needed) {
  return [{ json: { message: \`❓ \${$json.clarification_needed || 'Need more details.'}\` } }];
}

const params = $json.params || {};

if (action === 'add_comment') {
  return [{ json: {
    action: 'add_comment',
    issueId: params.issue_id,
    titleHint: params.title_hint,
    comment: params.comment,
    username: $json.username,
  }}];
}

return [{ json: { message: \`❌ I didn't understand that command. Try:\\n• \\\"summary of ENG-10\\\"\\n• \\\"create issue Fix the login bug\\\"\\n• \\\"list repos\\\"\\n• \\\"plan fix ENG-11 in my-repo\\\"\\n• \\\"assign ENG-456 to John\\\"\\n• \\\"search open bugs\\\"\` } }];`;

function findNode(nodes, name) {
  const node = nodes.find((n) => n.name === name);
  if (!node) throw new Error(`Node not found: ${name}`);
  return node;
}

function ensureNode(nodes, node) {
  const existing = nodes.find((n) => n.name === node.name);
  if (existing) Object.assign(existing, node);
  else nodes.push(node);
}

function connect(connections, source, target, branch) {
  if (!connections[source]) connections[source] = { main: [] };
  const outs = connections[source].main;
  const index = branch === 'true' ? 0 : branch === 'false' ? 1 : 0;
  while (outs.length <= index) outs.push([]);
  const list = outs[index];
  if (!list.some((c) => c.node === target)) {
    list.push({ node: target, type: 'main', index: 0 });
  }
}

function removeConnection(connections, source, target) {
  if (!connections[source]) return;
  connections[source].main = connections[source].main.map((branch) =>
    branch.filter((c) => c.node !== target),
  );
}

function setBranchConnections(connections, source, branch, targets) {
  if (!connections[source]) connections[source] = { main: [] };
  const outs = connections[source].main;
  const index = branch === 'true' ? 0 : branch === 'false' ? 1 : 0;
  while (outs.length <= index) outs.push([]);
  outs[index] = targets.map((node) => ({ node, type: 'main', index: 0 }));
}

async function main() {
  const apiKey = process.env.N8N_API_KEY;
  if (!apiKey) throw new Error('N8N_API_KEY missing');

  const base = 'https://n8n.techflowlabs.gr/api/v1';
  const headers = { 'X-N8N-API-KEY': apiKey, 'Content-Type': 'application/json' };

  const workflow = await (await fetch(`${base}/workflows/${WORKFLOW_ID}`, { headers })).json();
  let nodes = workflow.nodes;
  const connections = { ...workflow.connections };

  // Remove deprecated nodes from older patches
  const deprecatedNodeNames = [
    'GitHub: Create Plan Gist',
    'GitHub: Save Plan Doc',
    'Linear: Attach Plan Doc',
  ];
  nodes = nodes.filter((n) => !deprecatedNodeNames.includes(n.name));
  for (const name of deprecatedNodeNames) {
    delete connections[name];
    for (const source of Object.keys(connections)) {
      connections[source].main = connections[source].main.map((branch) =>
        (branch || []).filter((c) => !deprecatedNodeNames.includes(c.node)),
      );
    }
  }

  findNode(nodes, 'Extract Message').parameters.jsCode = EXTRACT_MESSAGE_CODE;
  findNode(nodes, 'Parse AI Response').parameters.jsCode = PARSE_AI_EXTRA;
  findNode(nodes, 'Handle Comment / Unknown').parameters.jsCode = HANDLE_UNKNOWN_CODE;

  const aiNode = findNode(nodes, 'AI: Parse Command');
  const currentSystem =
    aiNode.parameters?.options?.system ||
    aiNode.parameters?.messages?.values?.[0]?.content ||
    '';
  if (!currentSystem.includes('list_repos')) {
    const newSystem = `${currentSystem}${AI_SYSTEM_APPEND}`;
    if (aiNode.parameters.options) {
      aiNode.parameters.options.system = newSystem;
    }
  }

  ensureNode(nodes, {
    id: 'command-shortcuts',
    name: 'Command Shortcuts',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [880, -320],
    parameters: {
      jsCode: `const extract = $input.first().json;
const msg = (extract.userMessage || '').trim();
const lower = msg.toLowerCase();

let action = null;
const params = {};

if (/^list\\s+repos?$/.test(lower)) {
  action = 'list_repos';
}

const summaryMatch =
  msg.match(/summary\\s+of\\s+(?:the\\s+)?([A-Za-z]+-\\d+)/i) ||
  msg.match(/(?:summary|summarize|summarise)\\s+(?:of\\s+(?:the\\s+)?)?([A-Za-z]+-\\d+)/i) ||
  msg.match(/\\b([A-Za-z]+-\\d+)\\b[^\\n]{0,40}(?:summary|summarize|summarise)/i);
if (summaryMatch) {
  action = 'summarize_issue';
  params.issue_id = summaryMatch[1].toUpperCase();
}

const seeMatch =
  msg.match(/(?:can you see|do you see|show me|tell me about|what is|look at|check)\\s+(?:the\\s+)?(?:issue\\s+)?([A-Za-z]+-\\d+)/i) ||
  msg.match(/\\b([A-Za-z]+-\\d+)\\b[^\\n]{0,30}\\?/i);
if (!action && seeMatch) {
  action = 'summarize_issue';
  params.issue_id = seeMatch[1].toUpperCase();
}

const planMatch = msg.match(/^plan\\s+(.+)$/i);
if (planMatch) {
  action = 'plan_github';
  const rest = planMatch[1];
  const issue = rest.match(/\\b([A-Za-z]+-\\d+)\\b/);
  if (issue) params.issue_id = issue[1].toUpperCase();
  const repo = rest.match(/\\bin\\s+([A-Za-z0-9._-]+)(?:\\s+repo)?\\s*$/i);
  if (repo) params.repo = repo[1];
  params.summary = rest.replace(/\\bin\\s+[A-Za-z0-9._-]+(?:\\s+repo)?\\s*$/i, '').trim() || rest;
}

if (action) {
  return [{
    json: {
      action,
      params,
      shortcut: true,
      userMessage: extract.userMessage,
      channelId: extract.channelId,
      userId: extract.userId,
      username: extract.username,
      hasPendingPlan: extract.hasPendingPlan,
    }
  }];
}

return [{ json: { ...extract, shortcut: false } }];`,
    },
  });

  ensureNode(nodes, {
    id: 'shortcut-summarize-if',
    name: 'Shortcut: Summarize?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    position: [960, -480],
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            leftValue: '={{ $json.action }}',
            rightValue: 'summarize_issue',
            operator: { type: 'string', operation: 'equals' },
          },
        ],
        options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' },
      },
      options: {},
    },
  });

  ensureNode(nodes, {
    id: 'has-shortcut-if',
    name: 'Has Shortcut?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    position: [1056, -320],
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            leftValue: '={{ $json.action }}',
            operator: { type: 'string', operation: 'notEmpty' },
          },
        ],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      },
      options: {},
    },
  });

  ensureNode(nodes, {
    id: 'bridge-execute-if',
    name: 'Bridge Execute?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    position: [784, -160],
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            leftValue: '={{ $json.bridgeAction }}',
            rightValue: 'execute_plan',
            operator: { type: 'string', operation: 'equals' },
          },
        ],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      },
      options: {},
    },
  });

  ensureNode(nodes, {
    id: 'bridge-prepare-execute',
    name: 'Bridge: Prepare Execute',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [992, -160],
    parameters: {
      jsCode: `const extract = $input.first().json;
return [{
  json: {
    action: 'execute_plan',
    params: { plan: extract.pendingPlan },
    username: extract.username,
    channelId: extract.channelId,
    userId: extract.userId,
  }
}];`,
    },
  });

  ensureNode(nodes, {
    id: 'is-list-repos',
    name: 'Is List Repos?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    position: [1264, 128],
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            leftValue: '={{ $json.action }}',
            rightValue: 'list_repos',
            operator: { type: 'string', operation: 'equals' },
          },
        ],
        options: { caseSensitive: false },
      },
      options: {},
    },
  });

  ensureNode(nodes, {
    id: 'is-plan-github',
    name: 'Is Plan GitHub?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    position: [1264, 256],
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            leftValue: '={{ $json.action }}',
            rightValue: 'plan_github',
            operator: { type: 'string', operation: 'equals' },
          },
        ],
        options: { caseSensitive: false },
      },
      options: {},
    },
  });

  ensureNode(nodes, {
    id: 'is-summarize-issue',
    name: 'Is Summarize Issue?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    position: [1264, 512],
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            leftValue: '={{ $json.action }}',
            rightValue: 'summarize_issue',
            operator: { type: 'string', operation: 'equals' },
          },
        ],
        options: { caseSensitive: false },
      },
      options: {},
    },
  });

  ensureNode(nodes, {
    id: 'is-execute-plan',
    name: 'Is Execute Plan?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    position: [1264, 384],
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            leftValue: '={{ $json.action }}',
            rightValue: 'execute_plan',
            operator: { type: 'string', operation: 'equals' },
          },
        ],
        options: { caseSensitive: false },
      },
      options: {},
    },
  });

  ensureNode(nodes, {
    id: 'github-list-repos',
    name: 'GitHub: List Repos',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1504, 128],
    parameters: {
      method: 'GET',
      url: `https://api.github.com/orgs/${GITHUB_ORG}/repos`,
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'per_page', value: '100' },
          { name: 'sort', value: 'updated' },
        ],
      },
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Authorization', value: `Bearer ${GITHUB_TOKEN}` },
          { name: 'Accept', value: 'application/vnd.github+json' },
          { name: 'X-GitHub-Api-Version', value: '2022-11-28' },
        ],
      },
      options: {},
    },
  });

  ensureNode(nodes, {
    id: 'format-repo-list',
    name: 'Format: Repo List',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1744, 128],
    parameters: { jsCode: FORMAT_REPOS_CODE },
  });

  ensureNode(nodes, {
    id: 'linear-resolve-issue-plan',
    name: 'Linear: Resolve Issue (Plan)',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1504, 256],
    credentials: LINEAR_CRED,
    parameters: {
      method: 'POST',
      url: 'https://api.linear.app/graphql',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      bodyParameters: {
        parameters: [
          {
            name: 'query',
            value:
              'query FindIssue($teamId: ID!, $number: Float!) {\n  issues(filter: {\n    team: { id: { eq: $teamId } }\n    number: { eq: $number }\n  }, first: 1) {\n    nodes { id identifier title url description }\n  }\n}',
          },
          {
            name: 'variables',
            value:
              "={{ (() => { const sc = $('Command Shortcuts').first().json; const src = sc.action === 'plan_github' ? sc : $('Parse AI Response').first().json; const id = src.params?.issue_id || ''; const m = id.match(/^([A-Z]+)-(\\d+)$/i); return JSON.stringify({ teamId: 'a28a98ff-3d04-4ab4-bcb9-cd03f165ac2a', number: m ? Number(m[2]) : 0 }); })() }}",
          },
        ],
      },
      options: {},
    },
  });

  ensureNode(nodes, {
    id: 'linear-resolve-issue-summary',
    name: 'Linear: Resolve Issue (Summary)',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1504, 512],
    credentials: LINEAR_CRED,
    parameters: {
      method: 'POST',
      url: 'https://api.linear.app/graphql',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      bodyParameters: {
        parameters: [
          {
            name: 'query',
            value:
              'query FindIssue($teamId: ID!, $number: Float!) {\n  issues(filter: {\n    team: { id: { eq: $teamId } }\n    number: { eq: $number }\n  }, first: 1) {\n    nodes {\n      id\n      identifier\n      title\n      url\n      description\n      priority\n      state { name }\n      assignee { name }\n      labels { nodes { name } }\n    }\n  }\n}',
          },
          {
            name: 'variables',
            value:
              "={{ (() => { const src = $('Shortcut: Summarize?').first()?.json || $('Command Shortcuts').first()?.json || $('Parse AI Response').first()?.json || {}; const id = src.params?.issue_id || ''; const m = id.match(/^([A-Z]+)-(\\d+)$/i); return JSON.stringify({ teamId: 'a28a98ff-3d04-4ab4-bcb9-cd03f165ac2a', number: m ? Number(m[2]) : 0 }); })() }}",
          },
        ],
      },
      options: {},
    },
  });

  ensureNode(nodes, {
    id: 'format-issue-summary',
    name: 'Format: Issue Summary',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1744, 512],
    parameters: { jsCode: FORMAT_ISSUE_SUMMARY_CODE },
  });

  ensureNode(nodes, {
    id: 'plan-format-document',
    name: 'Plan: Format Document',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1968, 256],
    parameters: { jsCode: PLAN_FORMAT_DOCUMENT_CODE },
  });

  ensureNode(nodes, {
    id: 'linear-create-plan-document',
    name: 'Linear: Create Plan Document',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [2192, 256],
    credentials: LINEAR_CRED,
    parameters: {
      method: 'POST',
      url: 'https://api.linear.app/graphql',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      bodyParameters: {
        parameters: [
          {
            name: 'query',
            value:
              'mutation DocumentCreate($input: DocumentCreateInput!) {\n  documentCreate(input: $input) {\n    success\n    document {\n      id\n      title\n      url\n      slugId\n    }\n  }\n}',
          },
          {
            name: 'variables',
            value:
              '={{ JSON.stringify({ input: { title: $json.documentTitle, issueId: $json.pendingPlan.issueId, content: $json.markdown } }) }}',
          },
        ],
      },
      options: {},
    },
  });

  ensureNode(nodes, {
    id: 'github-create-plan-issue',
    name: 'GitHub: Create Plan Issue',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [2416, 256],
    parameters: { jsCode: GITHUB_CREATE_ISSUE_CODE },
  });

  ensureNode(nodes, {
    id: 'plan-finalize-message',
    name: 'Plan: Finalize Message',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [2640, 256],
    parameters: { jsCode: PLAN_FINALIZE_CODE },
  });

  ensureNode(nodes, {
    id: 'build-pending-plan',
    name: 'Build Pending Plan',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1744, 256],
    parameters: { jsCode: BUILD_PLAN_CODE },
  });

  ensureNode(nodes, {
    id: 'execute-pending-plan',
    name: 'Execute Pending Plan',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1504, 384],
    parameters: { jsCode: EXECUTE_PLAN_CODE },
  });

  const respond = findNode(nodes, 'Respond to Webhook');
  respond.parameters.responseBody =
    "={{ JSON.stringify({ message: $json.message || 'Done', issueUrl: $json.issueUrl || null, planDocUrl: $json.planDocUrl || $json.pendingPlan?.planDocUrl || null, githubIssueUrl: $json.githubIssueUrl || $json.pendingPlan?.githubIssueUrl || null, pendingPlan: $json.pendingPlan || null, clearPendingPlan: $json.clearPendingPlan || false, data: { content: $json.message || 'Done' } }) }}";

  const actionTargets = [
    'Is Create Issue?',
    'Is Update Status?',
    'Is Search?',
    'Is Assign?',
    'Is List Repos?',
    'Is Plan GitHub?',
    'Is Execute Plan?',
    'Is Summarize Issue?',
    'Handle Comment / Unknown',
  ];

  const searchNode = findNode(nodes, 'Linear: Search Issues');
  const searchVars = searchNode.parameters.bodyParameters?.parameters?.find((p) => p.name === 'variables');
  if (searchVars) {
    searchVars.value =
      '={{ JSON.stringify({ query: $json.params.query || $json.params.issue_id || $json.userMessage || "" }) }}';
  }

  connections['Parse AI Response'] = {
    main: [actionTargets.map((node) => ({ node, type: 'main', index: 0 }))],
  };

  connect(connections, 'Is List Repos?', 'GitHub: List Repos', 'true');
  connect(connections, 'GitHub: List Repos', 'Format: Repo List');
  connect(connections, 'Format: Repo List', 'Slash via bridge?');

  connect(connections, 'Is Plan GitHub?', 'Linear: Resolve Issue (Plan)', 'true');
  connect(connections, 'Linear: Resolve Issue (Plan)', 'Build Pending Plan');
  connections['Build Pending Plan'] = {
    main: [[{ node: 'Plan: Format Document', type: 'main', index: 0 }]],
  };
  connect(connections, 'Plan: Format Document', 'Linear: Create Plan Document');
  connect(connections, 'Linear: Create Plan Document', 'GitHub: Create Plan Issue');
  connect(connections, 'GitHub: Create Plan Issue', 'Plan: Finalize Message');
  connect(connections, 'Plan: Finalize Message', 'Slash via bridge?');

  connect(connections, 'Is Summarize Issue?', 'Linear: Resolve Issue (Summary)', 'true');
  connect(connections, 'Linear: Resolve Issue (Summary)', 'Format: Issue Summary');
  connect(connections, 'Format: Issue Summary', 'Slash via bridge?');

  connections['Extract Message'] = {
    main: [[{ node: 'Bridge Execute?', type: 'main', index: 0 }]],
  };

  connect(connections, 'Bridge Execute?', 'Bridge: Prepare Execute', 'true');
  removeConnection(connections, 'Bridge Execute?', 'AI: Parse Command');
  setBranchConnections(connections, 'Bridge Execute?', 'false', ['Command Shortcuts']);
  connections['Command Shortcuts'] = { main: [[]] };
  connect(connections, 'Command Shortcuts', 'Shortcut: Summarize?');
  connect(connections, 'Shortcut: Summarize?', 'Linear: Resolve Issue (Summary)', 'true');
  connect(connections, 'Shortcut: Summarize?', 'Has Shortcut?', 'false');
  connections['Has Shortcut?'] = { main: [[], []] };
  connect(connections, 'Has Shortcut?', 'AI: Parse Command', 'false');

  for (const target of actionTargets.filter((t) => t !== 'Handle Comment / Unknown')) {
    connect(connections, 'Has Shortcut?', target, 'true');
  }

  connect(connections, 'Bridge: Prepare Execute', 'Execute Pending Plan');

  connect(connections, 'Is Execute Plan?', 'Execute Pending Plan', 'true');
  connect(connections, 'Execute Pending Plan', 'Slash via bridge?');

  // Execute plan bypasses AI — wire Extract -> Parse directly when bridge sends execute
  // Parse AI still needs AI output when not execute; bridge execute is handled inside Parse AI code at top

  const payload = {
    name: workflow.name,
    nodes,
    connections,
    settings: { executionOrder: workflow.settings?.executionOrder || 'v1' },
    staticData: workflow.staticData,
  };

  const putRes = await fetch(`${base}/workflows/${WORKFLOW_ID}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(payload),
  });
  if (!putRes.ok) throw new Error(`PUT failed: ${putRes.status} ${await putRes.text()}`);

  console.log('Bridge flow + GitHub plan/execute patched.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
