/**
 * Generate the daily dev planning brief (forward-looking, .docx output).
 */

const { message } = require('./openai');
const { normalizeBriefMarkdown } = require('./codebase-brief-docx');
const {
  fetchCodebaseBriefData,
  formatBriefDataForPrompt,
  getTodayReportDateKey,
} = require('./codebase-brief-data');
const { getPrimaryRepoFullName } = require('./commit-summary-flow');

const BRIEF_SYSTEM = `Είσαι tech lead της Emblem Tameiaki. Γράφεις καθημερινό brief ΠΛΑΝΟΥ ΗΜΕΡΑΣ για developers.

Στόχος: να ξέρει η ομάδα τι έχει ΟΛΟΚΛΗΡΩΘΕΙ πρόσφατα και τι πρέπει να κάνει ΣΗΜΕΡΑ — με σαφή προτεραιότητα.

Κανόνες:
- Γράφεις στα Ελληνικά, πρακτικά και συγκεκριμένα
- ΜΗΝ εφευρίσκεις commits, issues, PRs ή tasks που δεν υπάρχουν στα δεδομένα
- Τα «πρέπει να γίνει σήμερα» πρέπει να είναι actionable (merge, test, fix, review, deploy, verify)
- Προτεραιότητα: blockers > merge/release > device testing > open bugs > tech debt
- Αν λείπουν δεδομένα, πες τι να ελεγχθεί χειροκίνητα — όχι generic advice
- ΜΗΝ τυλίγεις την απάντηση σε code fences (\`\`\`markdown) — γύρνα καθαρό markdown`;

function buildBriefUserPrompt(dataBlock, reportDateLabel) {
  return [
    `Σύνταξε BRIEF ΠΛΑΝΟΥ ΗΜΕΡΑΣ για **${reportDateLabel}**.`,
  'Η ανάλυση βασίζεται σε commits των τελευταίων ημερών, ανοιχτά issues/PRs, feature branches και commit reviews.',
    '',
    'Χρησιμοποίησε ΑΚΡΙΒΩΣ αυτή τη δομή (markdown headings):',
    '',
    '# BRIEF ΕΡΓΑΣΙΩΝ',
    `## Πλάνο ημέρας — ${reportDateLabel}`,
    '(1-2 προτάσεις: τι κυριαρχεί σήμερα και γιατί)',
    '',
    '## ✅ Τι έχει γίνει (τελευταίες ημέρες)',
    'Ομαδοποίησε λειτουργικά τις πρόσφατες αλλαγές (όχι απλά λίστα commits).',
    'Αν υπάρχουν merged PRs ή feature branches, δείξε τι ολοκληρώθηκε ή προχώρησε.',
    '',
    '## 🎯 Τι πρέπει να γίνει σήμερα — κατά προτεραιότητα',
    'Αριθμημένη λίστα 5-10 concrete tasks για ΣΗΜΕΡΑ.',
    'Κάθε task: τι, γιατί τώρα, και (αν φαίνεται) ποιο branch/issue/commit σχετίζεται.',
    'Ξεκίνα από το πιο κρίσιμο (#1 = tackle first).',
    '',
    '## Ανοιχτά PRs & issues που επηρεάζουν το πλάνο',
    'Σύντομη λίστα με σύνδεση προς σημερινές εργασίες.',
    '',
    '## Feature branches σε εξέλιξη',
    'Τι μένει για merge, τι χρειάζεται test (Sunmi/PAX/SoftPOS κλπ αν σχετίζεται).',
    '',
    '## Σημεία επαλήθευσης & ρίσκα',
    'Bullets από commit reviews ή από τη φύση των αλλαγών — τι να testάρει η ομάδα σήμερα.',
    '',
    '## Σημείωση μεθοδολογίας',
    'Μία πρόταση: δεδομένα από GitHub API + αποθηκευμένα commit reviews.',
    '',
    '---',
    'Δεδομένα:',
    dataBlock,
  ].join('\n');
}

async function generateCodebaseBrief({
  repoFullName,
  reportDateKey,
  timeZone = process.env.CODEBASE_BRIEF_TZ || 'Europe/Athens',
  apiKey = process.env.OPENAI_API_KEY,
}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set.');

  const data = await fetchCodebaseBriefData({ repoFullName, reportDateKey, timeZone });
  const model = process.env.CODEBASE_BRIEF_MODEL
    || process.env.OPENAI_MODEL
    || 'gpt-4o';

  const { text } = await message({
    apiKey,
    model,
    system: BRIEF_SYSTEM,
    user: buildBriefUserPrompt(formatBriefDataForPrompt(data), data.reportDateLabel),
    maxTokens: Number(process.env.CODEBASE_BRIEF_MAX_TOKENS || 6000),
    timeoutMs: Number(process.env.CODEBASE_BRIEF_TIMEOUT_MS || 180000),
  });

  const body = normalizeBriefMarkdown(text);
  if (!body) throw new Error('AI returned an empty brief.');

  return {
    repoFullName,
    reportDateKey: data.reportDateKey,
    reportDateLabel: data.reportDateLabel,
    timeZone,
    lookbackDays: data.lookbackDays,
    commitCount: data.commits.length,
    markdown: body,
    filename: `Brief-dev-${data.reportDateKey}.docx`,
  };
}

async function runDailyCodebaseBrief({
  repoFullName = getPrimaryRepoFullName(),
  reportDateKey = getTodayReportDateKey(process.env.CODEBASE_BRIEF_TZ || 'Europe/Athens'),
  timeZone = process.env.CODEBASE_BRIEF_TZ || 'Europe/Athens',
} = {}) {
  return generateCodebaseBrief({ repoFullName, reportDateKey, timeZone });
}

module.exports = {
  generateCodebaseBrief,
  runDailyCodebaseBrief,
};
