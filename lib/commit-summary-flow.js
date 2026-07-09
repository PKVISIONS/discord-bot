/**
 * Interactive commit summary: pick repo → pick branch (with latest commit) → AI review.
 */

const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const { createClient, createClientForFullName, parseRepoFullName } = require('./github-api');
const { reviewCommit } = require('./commit-review');

const MAX_MENU_OPTIONS = 25;
const BRANCH_FETCH_CONCURRENCY = 8;
const MENU_TTL_MS = 10 * 60 * 1000;

/** @type {Map<string, { repoFullName?: string, expiresAt: number }>} */
const sessions = new Map();

function sessionKey(userId) {
  return String(userId);
}

function setSession(userId, data) {
  sessions.set(sessionKey(userId), {
    ...data,
    expiresAt: Date.now() + MENU_TTL_MS,
  });
}

function getSession(userId) {
  const entry = sessions.get(sessionKey(userId));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    sessions.delete(sessionKey(userId));
    return null;
  }
  return entry;
}

function truncate(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index;
      index += 1;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function getGithubToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set.');
  return token;
}

function getPrimaryRepoFullName() {
  return process.env.GITHUB_REPO || 'semantic-software/EmblemTameiaki';
}

function isPrimaryRepoHint(hint) {
  if (!hint) return false;
  const primary = getPrimaryRepoFullName();
  const primaryName = primary.split('/').pop() || '';
  const normalized = String(hint).trim().toLowerCase();
  return normalized === primary.toLowerCase() || normalized === primaryName.toLowerCase();
}

async function fetchPrimaryRepoEntry() {
  const token = getGithubToken();
  const fullName = getPrimaryRepoFullName();
  const { client, repo } = createClientForFullName(token, fullName);
  const info = await client.getRepo(repo);
  return {
    fullName: info.full_name,
    name: info.name,
    defaultBranch: info.default_branch,
    updatedAt: info.updated_at,
    private: info.private,
  };
}

async function listAccessibleRepos() {
  try {
    return [await fetchPrimaryRepoEntry()];
  } catch {
    throw new Error(`Cannot access ${getPrimaryRepoFullName()}. Check GITHUB_TOKEN and GITHUB_REPO in .env.`);
  }
}

async function resolveRepoFromHint(hint) {
  if (!hint) return null;
  if (!isPrimaryRepoHint(hint)) return null;

  const token = getGithubToken();
  const fullName = getPrimaryRepoFullName();
  const { client, repo } = createClientForFullName(token, fullName);
  await client.getRepo(repo);
  return fullName;
}

function fitDiscordContent(text, max = 2000) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max - 20)}\n\n…_(truncated)_`;
}

function formatBranchPreviewLines(branches, maxChars = 1200) {
  const lines = [];
  let used = 0;

  for (const b of branches.slice(0, MAX_MENU_OPTIONS)) {
    const line = `\`${truncate(b.name, 60)}\` · \`${b.shortSha}\` — ${truncate(b.message, 50)}`;
    if (used + line.length + 1 > maxChars) {
      const remaining = branches.length - lines.length;
      if (remaining > 0) {
        lines.push(`_…and ${remaining} more branch${remaining === 1 ? '' : 'es'} — use the menu below._`);
      }
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }

  return lines.join('\n');
}

function buildRepoSelectMenu(userId, repos) {
  const options = repos.slice(0, MAX_MENU_OPTIONS).map((repo) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(truncate(repo.name, 100))
      .setDescription(truncate(`default: ${repo.defaultBranch}${repo.private ? ' · private' : ''}`, 100))
      .setValue(repo.fullName),
  );

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`commit_review:repo:${userId}`)
    .setPlaceholder('Choose a repository…')
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

function buildBranchSelectMenu(userId, repoFullName, branches) {
  const options = branches.slice(0, MAX_MENU_OPTIONS).map((b) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(truncate(b.name, 100))
      .setDescription(truncate(`${b.shortSha} — ${b.message}`, 100))
      .setValue(b.name),
  );

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`commit_review:branch:${userId}:${Buffer.from(repoFullName).toString('base64url')}`)
    .setPlaceholder('Choose a branch…')
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

async function fetchBranchesWithLatestCommit(repoFullName) {
  const token = getGithubToken();
  const { client, repo } = createClientForFullName(token, repoFullName);
  const branchList = await client.listAllBranches(repo);

  const enriched = await mapPool(branchList, BRANCH_FETCH_CONCURRENCY, async (branch) => {
    try {
      const commits = await client.listCommits(repo, { sha: branch.name, perPage: 1 });
      const latest = commits[0];
      const message = (latest?.commit?.message || '').split('\n')[0];
      const date = latest?.commit?.author?.date || latest?.commit?.committer?.date || null;
      return {
        name: branch.name,
        sha: latest?.sha || branch.commit?.sha || '',
        shortSha: (latest?.sha || branch.commit?.sha || '???????').slice(0, 7),
        message: message || '(no message)',
        date,
        url: latest?.html_url || '',
      };
    } catch {
      return {
        name: branch.name,
        sha: branch.commit?.sha || '',
        shortSha: (branch.commit?.sha || '???????').slice(0, 7),
        message: '(could not load commit)',
        date: null,
        url: '',
      };
    }
  });

  return enriched.sort((a, b) => {
    const ta = a.date ? new Date(a.date).getTime() : 0;
    const tb = b.date ? new Date(b.date).getTime() : 0;
    return tb - ta;
  });
}

async function startCommitSummaryFlow({ userId, parsed }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set — needed for commit summaries.');
  }

  let repoFullName = getPrimaryRepoFullName();

  if (parsed?.repoHint) {
    const resolved = await resolveRepoFromHint(parsed.repoHint);
    if (!resolved) {
      return {
        content: `Could not find repo \`${parsed.repoHint}\`. This bot only uses \`EmblemTameiaki\` (\`${repoFullName}\`).`,
      };
    }
    repoFullName = resolved;
  }

  if (parsed?.branchHint) {
    const branches = await fetchBranchesWithLatestCommit(repoFullName);
    const branch = branches.find((b) => b.name.toLowerCase() === parsed.branchHint.toLowerCase());
    if (!branch) {
      return {
        content: `Branch \`${parsed.branchHint}\` not found on \`${repoFullName}\`.`,
      };
    }
    return runReviewForBranch(repoFullName, branch);
  }

  return buildBranchPickerResponse(userId, repoFullName);
}

async function buildBranchPickerResponse(userId, repoFullName) {
  setSession(userId, { repoFullName });

  const branches = await fetchBranchesWithLatestCommit(repoFullName);
  if (!branches.length) {
    return { content: `No branches found on \`${repoFullName}\`.` };
  }

  const extra = branches.length > MAX_MENU_OPTIONS
    ? `\n_Showing ${MAX_MENU_OPTIONS} branches with the most recent activity._`
    : '';

  const content = fitDiscordContent([
    `**${repoFullName}** — choose a branch to review its latest commit:${extra}`,
    '',
    '_Each option shows the latest commit on that branch._',
    '',
    formatBranchPreviewLines(branches),
  ].join('\n'));

  return {
    content,
    components: [buildBranchSelectMenu(userId, repoFullName, branches)],
  };
}

async function runReviewForBranch(repoFullName, branch) {
  const commit = {
    sha: branch.sha,
    shortSha: branch.shortSha,
    message: branch.message,
    author: 'unknown',
    url: branch.url,
  };

  const result = await reviewCommit({
    repoFullName,
    branch: branch.name,
    commit,
    compareUrl: branch.url,
    onProgress: () => {},
  });

  return {
    content: result.messages[0],
    extraMessages: result.messages.slice(1),
  };
}

async function handleRepoSelect(interaction) {
  const userId = interaction.customId.split(':')[2];
  if (interaction.user.id !== userId) {
    await interaction.reply({ content: 'This menu is not for you.', ephemeral: true });
    return;
  }

  const repoFullName = getPrimaryRepoFullName();
  await interaction.deferUpdate();

  try {
    const response = await buildBranchPickerResponse(userId, repoFullName);
    await interaction.editReply({
      content: fitDiscordContent(response.content),
      components: response.components || [],
    });
  } catch (error) {
    await interaction.editReply({
      content: `❌ ${error.message}`,
      components: [],
    });
  }
}

async function handleBranchSelect(interaction) {
  const parts = interaction.customId.split(':');
  const userId = parts[2];
  const repoFullName = Buffer.from(parts[3], 'base64url').toString('utf8');

  if (interaction.user.id !== userId) {
    await interaction.reply({ content: 'This menu is not for you.', ephemeral: true });
    return;
  }

  const branchName = interaction.values[0];
  await interaction.update({
    content: `⏳ Reviewing latest commit on \`${repoFullName}\`@\`${branchName}\`…`,
    components: [],
  });

  try {
    const branches = await fetchBranchesWithLatestCommit(repoFullName);
    const branch = branches.find((b) => b.name === branchName);
    if (!branch) throw new Error(`Branch ${branchName} not found.`);

    const result = await runReviewForBranch(repoFullName, branch);
    await interaction.editReply({ content: fitDiscordContent(result.content), components: [] });

    for (const extra of result.extraMessages || []) {
      await interaction.followUp({ content: fitDiscordContent(extra) });
    }
  } catch (error) {
    await interaction.editReply({ content: `❌ ${error.message}`, components: [] });
  }
}

async function handleSelectInteraction(interaction) {
  if (!interaction.customId.startsWith('commit_review:')) return false;

  if (interaction.customId.startsWith('commit_review:repo:')) {
    await handleRepoSelect(interaction);
    return true;
  }

  if (interaction.customId.startsWith('commit_review:branch:')) {
    await handleBranchSelect(interaction);
    return true;
  }

  return false;
}

module.exports = {
  startCommitSummaryFlow,
  handleSelectInteraction,
  fetchBranchesWithLatestCommit,
  listAccessibleRepos,
  resolveRepoFromHint,
  getPrimaryRepoFullName,
};
