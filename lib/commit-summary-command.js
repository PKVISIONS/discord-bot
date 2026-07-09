/**
 * Detect "summarize last commit" style commands (handled locally, not n8n).
 */

const TRIGGER_RE =
  /^(commit\s+summary|summarize\s+last\s+commit|review\s+last\s+commit|last\s+commit\s+summary|commit\s+review)\b/i;

function parseCommitSummaryCommand(text) {
  const trimmed = text.trim();
  if (!TRIGGER_RE.test(trimmed)) return null;

  const repoMatch = trimmed.match(/\bin\s+([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)\b/i);
  const branchMatch = trimmed.match(/\b(?:on|branch)\s+([^\s]+)/i);

  return {
    repoHint: repoMatch?.[1] || null,
    branchHint: branchMatch?.[1] || null,
  };
}

function isCommitSummaryCommand(text) {
  return parseCommitSummaryCommand(text) !== null;
}

module.exports = {
  parseCommitSummaryCommand,
  isCommitSummaryCommand,
};
