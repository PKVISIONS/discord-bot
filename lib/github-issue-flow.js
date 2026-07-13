/**
 * Interactive GitHub issue creation — always uses EmblemTameiaki.
 * Classifies each issue as bug, feature, or task before opening.
 */

const { createClientForFullName } = require('./github-api');
const { getPrimaryRepoFullName, resolveRepoFromHint } = require('./commit-summary-flow');
const {
  classifyGitHubIssueType,
  detectUserIssueType,
  normalizeIssueType,
  resolveGitHubIssueTypeName,
  TYPE_LABELS,
} = require('./github-issue-classifier');
const { translateGitHubIssueToEnglish } = require('./github-issue-translator');

const DEFAULT_LABELS = String(process.env.GITHUB_ISSUE_LABEL || 'discord')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function parseLabels(raw) {
  if (!raw?.trim()) return [...DEFAULT_LABELS];
  const labels = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return labels.length ? labels : [...DEFAULT_LABELS];
}

function buildIssueLabels(userLabels) {
  const withoutTypes = userLabels.filter((label) => !detectUserIssueType([label]));
  return withoutTypes.length ? [...new Set(withoutTypes)] : [...DEFAULT_LABELS];
}

function formatClassificationBlock(classification) {
  if (!classification || classification.source !== 'ai' || !classification.reason) return '';
  return `_${classification.reason}_\n\n`;
}

function formatOriginalSubmissionBlock({ originalTitle, originalDescription, wasTranslated }) {
  if (!wasTranslated) return '';
  const lines = [
    '**Original submission**',
    `Title: ${originalTitle}`,
  ];
  if (originalDescription?.trim()) {
    lines.push('', originalDescription.trim());
  }
  return `${lines.join('\n')}\n\n`;
}

function formatIssueBody({
  classification,
  description,
  originalTitle,
  originalDescription,
  wasTranslated,
  username,
  userId,
}) {
  return [
    formatClassificationBlock(classification),
    description?.trim() || '',
    '',
    formatOriginalSubmissionBlock({ originalTitle, originalDescription, wasTranslated }),
    '---',
    `_Created via Discord by **${username}** (${userId})_`,
  ].join('\n').trim();
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
  repoFullName,
  title,
  description,
  labels,
  issueTypeName,
  username,
  userId,
  classification,
  originalTitle,
  originalDescription,
  wasTranslated,
}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set.');

  const { client, repo } = createClientForFullName(token, repoFullName);

  const body = formatIssueBody({
    classification,
    description,
    originalTitle,
    originalDescription,
    wasTranslated,
    username,
    userId,
  });

  const payload = {
    title: title.trim(),
    body,
  };

  const attempts = [
    { labels, type: issueTypeName },
    { labels, type: null },
    { labels: [], type: issueTypeName },
    { labels: [], type: null },
  ].filter((attempt, index, arr) => {
    const key = `${attempt.labels.join(',')}|${attempt.type || ''}`;
    return arr.findIndex((a) => `${a.labels.join(',')}|${a.type || ''}` === key) === index;
  });

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const issue = await client.createIssue(repo, {
        ...payload,
        labels: attempt.labels,
        type: attempt.type,
      });
      return {
        issueUrl: issue.html_url,
        issueNumber: issue.number,
        repoFullName,
        labelsApplied: attempt.labels,
        issueTypeApplied: attempt.type,
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

async function resolveIssueClassification({ title, description, userLabels, typeRaw }) {
  const userType = normalizeIssueType(typeRaw) || detectUserIssueType(userLabels);
  if (userType) {
    return {
      type: userType,
      typeLabel: TYPE_LABELS[userType],
      confidence: 'high',
      reason: typeRaw ? 'Type set explicitly in command.' : 'Type set explicitly in labels.',
      source: 'user',
    };
  }

  return classifyGitHubIssueType({ title, description });
}

async function startGitHubIssueFlow({
  userId, username, title, description, repoHint, labelsRaw, typeRaw,
}) {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is not set.');
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set — required to translate and classify issues.');
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

  const [classification, translation] = await Promise.all([
    resolveIssueClassification({
      title: trimmedTitle,
      description,
      userLabels,
      typeRaw,
    }),
    translateGitHubIssueToEnglish({
      title: trimmedTitle,
      description,
    }),
  ]);

  const labels = buildIssueLabels(userLabels);
  const issueTypeName = resolveGitHubIssueTypeName(classification.type);

  const result = await createGitHubIssue({
    repoFullName,
    title: translation.title,
    description: translation.description,
    labels,
    issueTypeName,
    username,
    userId,
    classification,
    originalTitle: trimmedTitle,
    originalDescription: description,
    wasTranslated: translation.wasTranslated,
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
