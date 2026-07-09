/**
 * Detect sales / customer support command.
 */

const TRIGGER_RE =
  /^(sales support|customer support|product support|sales help|support briefing|πωλήσεις|υποστήριξη πελατών|υποστήριξη|ενημερωτικό πωλήσεων)\b/i;

function parseSalesSupportCommand(text) {
  const trimmed = text.trim();
  if (!TRIGGER_RE.test(trimmed)) return null;

  const withoutTrigger = trimmed.replace(TRIGGER_RE, '').trim();

  const repoMatch = withoutTrigger.match(/\bin\s+([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)\b/i);
  let question = withoutTrigger;
  let repoHint = null;

  if (repoMatch) {
    repoHint = repoMatch[1];
    question = withoutTrigger.replace(repoMatch[0], '').trim();
  }

  question = question.replace(/^[:\-–—]\s*/, '').trim();

  return {
    repoHint,
    question: question || null,
  };
}

function isSalesSupportCommand(text) {
  return parseSalesSupportCommand(text) !== null;
}

module.exports = {
  parseSalesSupportCommand,
  isSalesSupportCommand,
};
