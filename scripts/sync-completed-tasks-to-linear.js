#!/usr/bin/env node
/**
 * Create or update Linear issues for completed Discord bot integration work.
 *
 * Usage:
 *   LINEAR_API_KEY=lin_api_... node scripts/sync-completed-tasks-to-linear.js
 *   LINEAR_API_KEY=lin_api_... node scripts/sync-completed-tasks-to-linear.js --dry-run
 *
 * Optional env:
 *   LINEAR_TEAM_ID       — overrides teamId in config JSON
 *   LINEAR_DONE_STATE    — exact workflow state name (default: Done)
 *   LINEAR_PROJECT_ID    — attach issues to a Linear project
 */

require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');

const API_URL = 'https://api.linear.app/graphql';
const CONFIG_PATH = path.join(__dirname, '../config/discord-bot-completed-tasks.json');
const dryRun = process.argv.includes('--dry-run');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const apiKey = process.env.LINEAR_API_KEY || '';
const teamId = process.env.LINEAR_TEAM_ID || config.teamId;
const doneStateName = process.env.LINEAR_DONE_STATE || 'Done';
const projectId = process.env.LINEAR_PROJECT_ID || '';

if (!apiKey && !dryRun) {
  console.error('Missing LINEAR_API_KEY. Get one from Linear → Settings → API → Personal API keys.');
  process.exit(1);
}

async function linear(query, variables = {}) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    const message = payload.errors?.map((e) => e.message).join('; ')
      || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload.data;
}

async function getDoneStateId() {
  const data = await linear(
    `query TeamStates($teamId: String!) {
      team(id: $teamId) {
        states { nodes { id name type } }
      }
    }`,
    { teamId },
  );

  const states = data.team?.states?.nodes || [];
  const exact = states.find((s) => s.name.toLowerCase() === doneStateName.toLowerCase());
  if (exact) return exact.id;

  const completed = states.find((s) => s.type === 'completed');
  if (completed) {
    console.warn(`State "${doneStateName}" not found; using "${completed.name}" (${completed.type}).`);
    return completed.id;
  }

  throw new Error(`No Done/completed workflow state found for team ${teamId}.`);
}

async function findExistingIssue(title) {
  const data = await linear(
    `query SearchIssues($query: String!) {
      issueSearch(query: $query, first: 5) {
        nodes { id identifier title state { name } url }
      }
    }`,
    { query: title },
  );

  const nodes = data.issueSearch?.nodes || [];
  return nodes.find((issue) => issue.title.trim() === title.trim()) || null;
}

async function createDoneIssue({ title, description, stateId }) {
  const input = {
    teamId,
    title,
    description,
    stateId,
  };

  if (projectId) input.projectId = projectId;

  const data = await linear(
    `mutation CreateIssue($input: IssueCreateInput!) {
      issueUpdate: issueCreate(input: $input) {
        success
        issue { id identifier title url state { name } }
      }
    }`,
    { input },
  );

  return data.issueUpdate?.issue;
}

async function markIssueDone(issueId, stateId) {
  const data = await linear(
    `mutation UpdateIssue($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
        issue { identifier title url state { name } }
      }
    }`,
    { id: issueId, stateId },
  );

  return data.issueUpdate?.issue;
}

async function main() {
  console.log(`Linear sync — team ${teamId}${dryRun ? ' (dry run)' : ''}`);
  console.log(`Tasks in config: ${config.tasks.length}`);

  if (dryRun) {
    for (const task of config.tasks) {
      console.log(`• [would sync] ${task.title}`);
    }
    return;
  }

  const doneStateId = await getDoneStateId();
  console.log(`Using Done state id: ${doneStateId}`);

  const results = { created: [], updated: [], skipped: [] };

  for (const task of config.tasks) {
    const title = task.title.trim();
    process.stdout.write(`→ ${title} … `);

    try {
      const existing = await findExistingIssue(title);

      if (existing) {
        if (existing.state?.name?.toLowerCase() === doneStateName.toLowerCase()) {
          console.log(`skip (${existing.identifier} already Done)`);
          results.skipped.push(existing);
          continue;
        }

        const updated = await markIssueDone(existing.id, doneStateId);
        console.log(`updated → ${updated.identifier} (${updated.state.name})`);
        results.updated.push(updated);
        continue;
      }

      const created = await createDoneIssue({
        title,
        description: task.description,
        stateId: doneStateId,
      });

      console.log(`created → ${created.identifier} (${created.state.name})`);
      results.created.push(created);
    } catch (error) {
      console.log(`error: ${error.message}`);
    }
  }

  console.log('\nSummary');
  console.log(`  Created: ${results.created.length}`);
  console.log(`  Updated: ${results.updated.length}`);
  console.log(`  Skipped: ${results.skipped.length}`);

  if (results.created.length) {
    console.log('\nNew issues:');
    for (const issue of results.created) {
      console.log(`  ${issue.identifier}  ${issue.url}`);
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
