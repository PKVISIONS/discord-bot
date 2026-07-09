#!/usr/bin/env node
/**
 * Patch the live "Discord → Linear Bot" workflow on n8n.
 * Usage: node scripts/patch-workflow.js
 */
require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');

const WORKFLOW_ID = 'fxxutl0HMJbv3p4G';
const LINEAR_CRED = { httpHeaderAuth: { id: 'NTfExkZEVJ06lSX7', name: 'HyperFrames API' } };

const userMapPath = path.join(__dirname, '..', 'config', 'discord-linear-users.json');
const DISCORD_LINEAR_USERS = JSON.parse(fs.readFileSync(userMapPath, 'utf8'));

function buildMatchAssigneeCode(userMap) {
  const mapJson = JSON.stringify(userMap, null, 2);
  return `// Find the assignee from team members list
const DISCORD_LINEAR_USERS = ${mapJson};

const membersResult = $input.first().json;
const originalAction = $('Parse AI Response').first().json;

const members = membersResult.data?.users?.nodes || [];
const rawAssignee = (originalAction.params?.assignee || '').trim();
const discordUser = (originalAction.username || '').trim();

function resolveSearchTerms(raw, discord) {
  const rawLower = raw.toLowerCase();
  const discordLower = discord.toLowerCase();
  const terms = new Set();

  const addMapping = (key) => {
    const mapped = DISCORD_LINEAR_USERS[key];
    if (!mapped) return;
    if (typeof mapped === 'string') {
      terms.add(mapped);
      return;
    }
    if (mapped.linearName) terms.add(mapped.linearName);
    if (mapped.linearEmail) terms.add(mapped.linearEmail);
    if (mapped.linearEmail) terms.add(mapped.linearEmail.split('@')[0]);
  };

  if (rawLower === 'me' || rawLower === 'myself') {
    addMapping(discordLower);
    if (!terms.size && discord) terms.add(discord);
  } else if (raw) {
    addMapping(rawLower);
    terms.add(raw);
  }

  if (!raw || rawLower === discordLower) addMapping(discordLower);

  if (!terms.size && raw) terms.add(raw);
  if (!terms.size && discord) terms.add(discord);

  return [...terms].filter(Boolean);
}

const searchTerms = resolveSearchTerms(rawAssignee, discordUser);

const matchedMember = members.find((m) => {
  const name = (m.name || m.displayName || '').toLowerCase();
  const email = (m.email || '').toLowerCase();
  const emailUser = email.split('@')[0] || '';

  return searchTerms.some((term) => {
    const t = term.toLowerCase();
    return name.includes(t) || email.includes(t) || emailUser === t || emailUser.includes(t);
  });
});

if (!matchedMember) {
  const names = members.map((m) => \`\${m.name}\${m.email ? \` (\${m.email})\` : ''}\`).join(', ');
  return [{ json: {
    message: \`❌ Person "\${rawAssignee || discordUser}" not found in workspace.\\nPeople: \${names || 'none'}\`,
    skip: true,
  }}];
}

return [{
  json: {
    assigneeId: matchedMember.id,
    assigneeName: matchedMember.name,
    issueIdentifier: originalAction.params?.issue_id,
    titleHint: originalAction.params?.title_hint,
    username: originalAction.username,
    skip: false,
  }
}];`;
}

const MATCH_ASSIGNEE_CODE = buildMatchAssigneeCode(DISCORD_LINEAR_USERS);

const EXTRACT_MESSAGE_CODE = `const root = $input.first().json;
let body = root.body || root;

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
} else if (body.data && body.data.resolved) {
  userMessage = body.data.name || '';
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

const PREPARE_ASSIGN_CODE = `const search = $input.first().json;
const match = $('Match Assignee').first().json;
const issue = search.data?.issues?.nodes?.[0];

if (!issue) {
  return [{ json: { message: \`❌ Issue "\${match.issueIdentifier}" not found.\` } }];
}

return [{
  json: {
    issueId: issue.id,
    assigneeId: match.assigneeId,
    assigneeName: match.assigneeName,
    username: match.username,
    identifier: issue.identifier,
  }
}];`;

const FORMAT_ASSIGNED_CODE = `const result = $input.first().json;
const issue = result.data?.issueUpdate?.issue;
const assigneeInfo = $('Prepare Assign').first().json;

if (!issue) {
  return [{ json: { message: '❌ Failed to assign issue. Make sure the issue ID is correct.' } }];
}

return [{
  json: {
    message: \`✅ **Issue Assigned!**\\n\\n**\${issue.identifier}** — \${issue.title}\\n👤 Assigned to: **\${issue.assignee?.name}**\\n\${issue.url}\\n\\n*Assigned by @\${assigneeInfo.username}*\`,
    issueUrl: issue.url,
  }
}];`;

const FORMAT_CREATED_CODE = `const result = $input.first().json;
const issue = result.data?.issueCreate?.issue;
const originalAction = $('Parse AI Response').first().json;

if (!issue) {
  return [{ json: { message: '❌ Failed to create issue. Please check your Linear API key and Team ID.' } }];
}

const priorityEmoji = { 0: '⚪', 1: '🔴', 2: '🟠', 3: '🟡', 4: '🔵' };
const emoji = priorityEmoji[issue.priority] || '⚪';

return [{
  json: {
    message: \`✅ **Issue Created!**\\n\\n\${emoji} **\${issue.identifier}** — \${issue.title}\\n📋 Status: \${issue.state?.name || 'Backlog'}\\n\${issue.url}\\n\\n*Created by @\${originalAction.username}*\`,
    issueUrl: issue.url,
  }
}];`;

const FORMAT_UPDATED_CODE = `const result = $input.first().json;
const issue = result.data?.issueUpdate?.issue;
const stateInfo = $('Match State').first().json;

if (!issue) {
  return [{ json: { message: '❌ Failed to update issue status. Make sure the issue ID is correct.' } }];
}

return [{
  json: {
    message: \`✅ **Status Updated!**\\n\\n**\${issue.identifier}** — \${issue.title}\\n📋 New Status: **\${issue.state?.name}**\\n\${issue.url}\\n\\n*Updated by @\${stateInfo.username}*\`,
    issueUrl: issue.url,
  }
}];`;

const FORMAT_SEARCH_CODE = `const result = $input.first().json;
const issues = result.data?.issueSearch?.nodes || [];
const originalAction = $('Parse AI Response').first().json;

if (issues.length === 0) {
  return [{ json: { message: \`🔍 No issues found for: "\${originalAction.params?.query}"\` } }];
}

const priorityLabel = { 0: 'None', 1: '🔴 Urgent', 2: '🟠 High', 3: '🟡 Medium', 4: '🔵 Low' };

const lines = issues.slice(0, 8).map((issue) => {
  const assignee = issue.assignee?.name || 'Unassigned';
  const priority = priorityLabel[issue.priority] || 'None';
  return \`• **\${issue.identifier}** — \${issue.title}\\n  └ \${issue.state?.name} · \${assignee} · \${priority}\\n  └ \${issue.url}\`;
}).join('\\n\\n');

return [{
  json: {
    message: \`🔍 **Found \${issues.length} issue(s)** for "\${originalAction.params?.query}":\\n\\n\${lines}\${issues.length > 8 ? \`\\n\\n*...and \${issues.length - 8} more*\` : ''}\`
  }
}];`;

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

async function main() {
  const apiKey = process.env.N8N_API_KEY;
  if (!apiKey) throw new Error('N8N_API_KEY missing from .env');

  const base = 'https://n8n.techflowlabs.gr/api/v1';
  const headers = {
    'X-N8N-API-KEY': apiKey,
    'Content-Type': 'application/json',
  };

  const getRes = await fetch(`${base}/workflows/${WORKFLOW_ID}`, { headers });
  if (!getRes.ok) throw new Error(`GET workflow failed: ${getRes.status} ${await getRes.text()}`);
  const workflow = await getRes.json();

  const nodes = workflow.nodes;
  const connections = { ...workflow.connections };

  findNode(nodes, 'Extract Message').parameters.jsCode = EXTRACT_MESSAGE_CODE;
  findNode(nodes, 'Match Assignee').parameters.jsCode = MATCH_ASSIGNEE_CODE;
  findNode(nodes, 'Format: Assigned').parameters.jsCode = FORMAT_ASSIGNED_CODE;
  findNode(nodes, 'Format: Created').parameters.jsCode = FORMAT_CREATED_CODE;
  findNode(nodes, 'Format: Updated').parameters.jsCode = FORMAT_UPDATED_CODE;
  findNode(nodes, 'Format: Search Results').parameters.jsCode = FORMAT_SEARCH_CODE;

  const getUsers = findNode(nodes, 'Linear: Get Team Members');
  getUsers.parameters.bodyParameters = {
    parameters: [
      {
        name: 'query',
        value:
          'query GetOrgUsers($first: Int) {\n  users(first: $first, filter: { active: { eq: true } }) {\n    nodes {\n      id\n      name\n      displayName\n      email\n    }\n  }\n}',
      },
      {
        name: 'variables',
        value: '={{ JSON.stringify({ first: 250 }) }}',
      },
    ],
  };

  const respond = findNode(nodes, 'Respond to Webhook');
  respond.parameters.responseBody =
    "={{ JSON.stringify({ message: $json.message || 'Done', issueUrl: $json.issueUrl || null, pendingPlan: $json.pendingPlan || null, clearPendingPlan: $json.clearPendingPlan || false, data: { content: $json.message || 'Done' } }) }}";

  ensureNode(nodes, {
    id: 'skip-assign-if',
    name: 'Skip Assign?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    position: [1904, -48],
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            id: 'skip-assign',
            leftValue: '={{ $json.skip }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'equals' },
          },
        ],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      },
      options: {},
    },
  });

  ensureNode(nodes, {
    id: 'linear-resolve-issue-assign',
    name: 'Linear: Resolve Issue (Assign)',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [2064, -48],
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
              'query FindIssue($teamId: ID!, $number: Float!) {\n  issues(filter: {\n    team: { id: { eq: $teamId } }\n    number: { eq: $number }\n  }, first: 1) {\n    nodes {\n      id\n      identifier\n      title\n      url\n    }\n  }\n}',
          },
          {
            name: 'variables',
            value:
              "={{ (() => { const id = $('Match Assignee').first().json.issueIdentifier || ''; const m = id.match(/^([A-Z]+)-(\\d+)$/i); return JSON.stringify({ teamId: 'a28a98ff-3d04-4ab4-bcb9-cd03f165ac2a', number: m ? Number(m[2]) : 0 }); })() }}",
          },
        ],
      },
      options: {},
    },
  });

  ensureNode(nodes, {
    id: 'prepare-assign-payload',
    name: 'Prepare Assign',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [2224, -48],
    parameters: { jsCode: PREPARE_ASSIGN_CODE },
  });

  ensureNode(nodes, {
    id: 'ready-to-assign-if',
    name: 'Ready to Assign?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    position: [2384, -48],
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            id: 'has-issue-id',
            leftValue: '={{ $json.issueId }}',
            operator: { type: 'string', operation: 'notEmpty' },
          },
        ],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      },
      options: {},
    },
  });

  ensureNode(nodes, {
    id: 'skip-discord-reply-if',
    name: 'Slash via bridge?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    position: [2368, -224],
    parameters: {
      conditions: {
        combinator: 'and',
        conditions: [
          {
            id: 'is-slash',
            leftValue: "={{ $('Extract Message').first().json.source }}",
            rightValue: 'slash',
            operator: { type: 'string', operation: 'equals' },
          },
        ],
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      },
      options: {},
    },
  });

  removeConnection(connections, 'Match Assignee', 'Linear: Assign Issue');
  connect(connections, 'Match Assignee', 'Skip Assign?');
  connect(connections, 'Skip Assign?', 'Slash via bridge?', 'true');
  connect(connections, 'Skip Assign?', 'Linear: Resolve Issue (Assign)', 'false');
  connect(connections, 'Linear: Resolve Issue (Assign)', 'Prepare Assign');
  connect(connections, 'Prepare Assign', 'Ready to Assign?');
  connect(connections, 'Ready to Assign?', 'Linear: Assign Issue', 'true');
  connect(connections, 'Ready to Assign?', 'Slash via bridge?', 'false');

  const replySources = [
    'Format: Created',
    'Format: Updated',
    'Format: Search Results',
    'Format: Assigned',
    'Handle Comment / Unknown',
  ];

  for (const source of replySources) {
    removeConnection(connections, source, 'Discord: Send Reply');
    connect(connections, source, 'Slash via bridge?');
  }

  removeConnection(connections, 'Slash via bridge?', 'Discord: Send Reply');
  connect(connections, 'Slash via bridge?', 'Respond to Webhook', 'true');
  connect(connections, 'Slash via bridge?', 'Discord: Send Reply', 'false');
  connect(connections, 'Discord: Send Reply', 'Respond to Webhook');

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

  const putText = await putRes.text();
  if (!putRes.ok) throw new Error(`PUT workflow failed: ${putRes.status} ${putText}`);

  console.log('Workflow patched successfully.');
  console.log('Discord→Linear user map entries:', Object.keys(DISCORD_LINEAR_USERS).join(', ') || '(none)');
  console.log('Nodes:', nodes.map((n) => n.name).join(', '));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
