/**
 * Lightweight intent detection for "app status" style questions.
 *
 * Goal: respond locally with recent features + potential problems/risks.
 */

const TRIGGER_RE = /(\bapp\b.*\bstatus\b|\bπού\b.*\bβρισκό\w+μεν?\b.*\bapp\b|\bπού\b.*\bβρισκό\w+\b|\bwhere\b.*\bapp\b|\brecent\b.*\bfeatures\b|\bπρόσφατ\w+\b.*\bfeatures\b|\bfeatures\b.*\bπρόσφατ\w+|\bpotential\b.*\bproblems\b|\bπιθανά\b.*\bπροβλήματα\b|\bπροβλήματα\b|\bρίσκο\b|\bκινδυν\w+\b|\broadmap\b|\brelease\b.*\bnotes\b|\bτι νέο\b|\bτι αλλάξ\w+\b|\bchangelog\b)/i;

function parseAppStatusCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  if (!TRIGGER_RE.test(trimmed)) return null;

  // Strip bot mention if any (caller already usually does it, but keep safe).
  const cleaned = trimmed.replace(/<@!?[0-9]+>\s*/g, '').trim();
  return {
    question: cleaned,
  };
}

module.exports = {
  parseAppStatusCommand,
};

