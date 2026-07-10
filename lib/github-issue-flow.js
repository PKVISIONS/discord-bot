/**
 * Interactive GitHub issue creation — always uses EmblemTameiaki.
 * Classifies each issue as bug, feature, or task before opening.
 */

const { createClientForFullName } = require('./github-api');
const { getPrimaryRepoFullName, resolveRepoFromHint } = require('./commit-summary-flow');
const {
  classifyGitHubIssueType,
  detectUserIssueType,
  TYPE_LABELS,
} = require('./github-issue-classifier');

const DEFAULT_LABELS = String(process.env.GITHUB_ISSUE_LABEL || 'discord')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function parseLabels(raw) {
  if (!raw?.trim()) return [...DEFAULT_LABELS];
  const labels = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return labels.length ? labels : [...DEFAULT_LABELS];
}

function buildIssueLabels(userLabels, issueType) {
  const withoutTypes = userLabels.filter((label) => !detectUserIssueType([label]));
  const merged = [issueType, ...withoutTypes];
  return [...new Set(merged)];
}

function formatClassificationBlock(classification) {
  if (!classification) return '';
  return [
    `**Issue type:** ${classification.typeLabel} (${classification.source === 'user' ? 'manual' : `AI · ${classification.confidence}`})`,
    classification.reason ? `_${classification.reason}_` : null,
    '',
  ].filter((line) => line !== null).join('\n');
}

function formatSuccessMessage({
  issueUrl,
  issueNumber,
  repoFullName,
  username,
  classification,
}) {
  const typeLine = classification
    ? ` as **${classification.typeLabel}**`
    : '';
  const reasonLine = classification?.reason && classification.source === 'ai'
    ? `\n_${classification.reason}_`
    : '';
  return [
    `✅ Issue **#${issueNumber}**${typeLine} created in \`${repoFullName}\` by **${username}**.`,
    issueUrl,
    reasonLine,
  ].filter(Boolean).join('\n');
}

async function createGitHubIssue({
  repoFullName, title, description, labels, username, userId, classification,
}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set.');

  const { client, repo } = createClientForFullName(token, repoFullName);

  const body = [
    formatClassificationBlock(classification),
    description?.trim() || '',
    '',
    '---',
    `_Created via Discord by **${username}** (${userId})_`,
  ].join('\n').trim();

  const payload = {
    title: title.trim(),
    body,
  };

  const labelAttempts = [
    labels,
    labels.filter((label) => label !== classification?.type),
    labels.filter((label) => !['bug', 'feature', 'task'].includes(String(label).toLowerCase())),
    [],
  ].filter((attempt, index, arr) => index === 0 || attempt.join(',') !== arr[index - 1].join(','));

  let lastError = null;
  for (const attemptLabels of labelAttempts) {
    try {
      const issue = await client.createIssue(repo, {
        ...payload,
        labels: attemptLabels,
      });
      return {
        issueUrl: issue.html_url,
        issueNumber: issue.number,
        repoFullName,
        labelsApplied: attemptLabels,
      };
    } catch (error) {
      lastError = error;
      const msg = String(error.message || '');
      if (error.status === 422 || msg.includes('422')) continue;
      if (msg.includes('403')) {
        throw new Error(
          'GitHub token lacks **Issues: Read and write** on this repository. Ask an admin to update the PAT.',
        );
      }
      throw error;
    }
  }

  throw lastError || new Error('Failed to create GitHub issue.');
}

async function resolveIssueRepo(repoHint) {
  if (repoHint) {
    const resolved = await resolveRepoFromHint(repoHint);
    if (!resolved) return null;
    return resolved;
  }
  return getPrimaryRepoFullName();
}

async function resolveIssueClassification({ title, description, userLabels }) {
  const userType = detectUserIssueType(userLabels);
  if (userType) {
    return {
      type: userType,
      typeLabel: TYPE_LABELS[userType],
      confidence: 'high',
      reason: 'Type set explicitly in labels.',
      source: 'user',
    };
  }

  return classifyGitHubIssueType({ title, description });
}

async function startGitHubIssueFlow({ userId, username, title, description, repoHint, labelsRaw }) {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is not set.');
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set — required to classify issues.');
  }

  const userLabels = parseLabels(labelsRaw);
  const trimmedTitle = title?.trim();
  if (!trimmedTitle) throw new Error('Issue title is required.');

  const repoFullName = await resolveIssueRepo(repoHint);
  if (!repoFullName) {
    return {
      content: `❌ Repository \`${repoHint}\` not found. This bot only uses \`EmblemTameiaki\` (\`${getPrimaryRepoFullName()}\`).`,
    };
  }

  const classification = await resolveIssueClassification({
    title: trimmedTitle,
    description,
    userLabels,
  });

  const labels = buildIssueLabels(userLabels, classification.type);

  const result = await createGitHubIssue({
    repoFullName,
    title: trimmedTitle,
    description,
    labels,
    username,
    userId,
    classification,
  });

  return {
    content: formatSuccessMessage({ ...result, username, classification }),
    classification,
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
  resolveIssueClassification,
};
