/**
 * Detect when an employee asks for sources (reply follow-up).
 */

const SOURCE_REQUEST_RE = /\b(πηγ[έε]ς|πηγή|sources?|citations?|resources?|references?)\b/i;

const SOURCE_REQUEST_PHRASES = [
  /με\s+πηγ/i,
  /δείξε.*πηγ/i,
  /δειξε.*πηγ/i,
  /που\s+(τα\s+)?(το\s+)?βρήκ/i,
  /που\s+(τα\s+)?(το\s+)?βρηκ/i,
  /από\s+που/i,
  /απο\s+που/i,
  /από\s+που\s+το/i,
  /απο\s+που\s+το/i,
  /πόθεν/i,
  /ποθεν/i,
  /βρήκες/i,
  /βρηκες/i,
  /show\s+(me\s+)?(the\s+)?sources/i,
  /include\s+sources/i,
  /list\s+sources/i,
  /με\s+αναφορές/i,
  /αναφορές.*πηγ/i,
  /cite\s+sources/i,
  /where\s+did\s+you\s+(find|get)/i,
  /where\s+(did\s+)?(this|that|it|the\s+info)/i,
  /what\s+sources/i,
  /what\s+resources/i,
  /based\s+on\s+what/i,
  /find\s+(the\s+)?(resources|info|information|this)/i,
];

const SOURCE_SHORT_RE = /^(πηγ[έε]ς|sources?|resources?|αναφορές|citations?|references?)\??$/i;

const SOURCE_LOOSE_RE = /(where|find|resource|source|reference|cite|based on|πηγ|βρήκ|βρηκ|πόθεν|ποθεν|από που|απο που|αναφορ|στοιχεί|πληροφορί)/i;

function isSourceFollowUpQuery(question, { hasStoredContext = false } = {}) {
  const q = String(question || '').trim();
  if (!q) return false;
  if (SOURCE_SHORT_RE.test(q)) return true;
  if (SOURCE_REQUEST_RE.test(q)) return true;
  if (SOURCE_REQUEST_PHRASES.some((pattern) => pattern.test(q))) return true;
  if (hasStoredContext && SOURCE_LOOSE_RE.test(q)) return true;
  return false;
}

/** @deprecated use isSourceFollowUpQuery */
function wantsEmployeeSources(question) {
  return isSourceFollowUpQuery(question);
}

module.exports = {
  isSourceFollowUpQuery,
  wantsEmployeeSources,
};
