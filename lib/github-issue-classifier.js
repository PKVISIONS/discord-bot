/**
 * Classify a GitHub issue as bug, feature, or task using the full title + description.
 */

const { message, parseJsonResponse } = require('./openai');

const ISSUE_TYPES = ['bug', 'feature', 'task'];

const TYPE_LABELS = {
  bug: 'Bug',
  feature: 'Feature',
  task: 'Task',
};

function normalizeIssueType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'bugs') return 'bug';
  if (raw === 'features') return 'feature';
  if (raw === 'tasks') return 'task';
  return ISSUE_TYPES.includes(raw) ? raw : null;
}

function detectUserIssueType(labels) {
  for (const label of labels) {
    const type = normalizeIssueType(label);
    if (type) return type;
  }
  return null;
}

async function classifyGitHubIssueType({ title, description, apiKey = process.env.OPENAI_API_KEY }) {
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set — required to classify issues.');
  }

  const model = process.env.GITHUB_ISSUE_CLASSIFY_MODEL
    || process.env.OPENAI_MODEL
    || 'gpt-4o-mini';

  const userPrompt = [
    'Classify this GitHub issue into exactly one type.',
    '',
    `Title: ${title}`,
    '',
    'Description:',
    description?.trim() || '(no description provided)',
    '',
    'Return JSON only:',
    '{ "type": "bug" | "feature" | "task", "confidence": "high" | "medium" | "low", "reason": "one short sentence in the same language as the issue" }',
    '',
    'Rules:',
    '- bug: something is broken, wrong, crash, regression, error, does not work as expected',
    '- feature: new capability, enhancement, improvement, new integration, user request for something new',
    '- task: chore, documentation, refactor, setup, release, investigation without a clear defect, internal work',
    '- Read the FULL title and description before deciding',
    '- If both bug and feature signals exist, prefer bug when current behavior is wrong',
  ].join('\n');

  const { text } = await message({
    apiKey,
    model,
    system: 'You classify software issues. Output valid JSON only.',
    user: userPrompt,
    maxTokens: 300,
    timeoutMs: Number(process.env.GITHUB_ISSUE_CLASSIFY_TIMEOUT_MS || 60000),
  });

  const parsed = parseJsonResponse(text);
  const type = normalizeIssueType(parsed.type);
  if (!type) {
    throw new Error(`AI returned invalid issue type: ${parsed.type}`);
  }

  const confidence = ['high', 'medium', 'low'].includes(parsed.confidence)
    ? parsed.confidence
    : 'medium';

  return {
    type,
    typeLabel: TYPE_LABELS[type],
    confidence,
    reason: String(parsed.reason || '').trim() || 'Classified from title and description.',
    source: 'ai',
  };
}

module.exports = {
  ISSUE_TYPES,
  TYPE_LABELS,
  normalizeIssueType,
  detectUserIssueType,
  classifyGitHubIssueType,
};
