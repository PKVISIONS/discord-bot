/**
 * Interactive GitHub issue creation — always uses EmblemTameiaki.
 */

const { createClientForFullName } = require('./github-api');
const { getPrimaryRepoFullName, resolveRepoFromHint } = require('./commit-summary-flow');

const DEFAULT_LABELS = ['discord'];

function truncate(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function parseLabels(raw) {
  if (!raw?.trim()) return DEFAULT_LABELS;
  const labels = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return labels.length ? labels : DEFAULT_LABELS;
}

function formatSuccessMessage({ issueUrl, issueNumber, repoFullName, username }) {
  return [
    `✅ Issue **#${issueNumber}** created in \`${repoFullName}\` by **${username}**.`,
    issueUrl,
  ].join('\n');
}

async function createGitHubIssue({
  repoFullName, title, description, labels, username, userId,
}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set.');

  const { client, repo } = createClientForFullName(token, repoFullName);

  const body = [
    description?.trim() || '',
    '',
    '---',
    `_Created via Discord by **${username}** (${userId})_`,
  ].join('\n').trim();

  try {
    const issue = await client.createIssue(repo, {
      title: title.trim(),
      body,
      labels,
    });

    return {
      issueUrl: issue.html_url,
      issueNumber: issue.number,
      repoFullName,
    };
  } catch (error) {
    const msg = String(error.message || '');
    if (msg.includes('403')) {
      throw new Error(
        'GitHub token lacks **Issues: Read and write** on this repository. Ask an admin to update the PAT.',
      );
    }
    throw error;
  }
}

async function resolveIssueRepo(repoHint) {
  if (repoHint) {
    const resolved = await resolveRepoFromHint(repoHint);
    if (!resolved) return null;
    return resolved;
  }
  return getPrimaryRepoFullName();
}

async function startGitHubIssueFlow({ userId, username, title, description, repoHint, labelsRaw }) {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is not set.');
  }

  const labels = parseLabels(labelsRaw);
  const trimmedTitle = title?.trim();
  if (!trimmedTitle) throw new Error('Issue title is required.');

  const repoFullName = await resolveIssueRepo(repoHint);
  if (!repoFullName) {
    return {
      content: `❌ Repository \`${repoHint}\` not found. This bot only uses \`EmblemTameiaki\` (\`${getPrimaryRepoFullName()}\`).`,
    };
  }

  const result = await createGitHubIssue({
    repoFullName,
    title: trimmedTitle,
    description,
    labels,
    username,
    userId,
  });

  return {
    content: formatSuccessMessage({ ...result, username }),
  };
}

async function handleSelectInteraction(interaction) {
  if (!interaction.customId.startsWith('github_issue:')) return false;

  if (interaction.customId.startsWith('github_issue:repo:')) {
    await interaction.reply({
      content: 'The repo picker is no longer used — this bot only works with EmblemTameiaki. Run `/github-issue` again.',
      ephemeral: true,
    });
    return true;
  }

  return false;
}

module.exports = {
  startGitHubIssueFlow,
  handleSelectInteraction,
};
