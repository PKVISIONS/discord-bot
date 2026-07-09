/**
 * Dev assistant — implementation plans, code ideas, and execution guidance.
 */

const { message } = require('./openai');
const { createClientForFullName, filterTreePaths } = require('./github-api');
const { fetchCodeActivity, formatCodeActivityForPrompt, isEmblemTameiakiRepo } = require('./code-activity');
const { retrieveContext, isIndexEmpty } = require('./retrieval');
const { getRecentReviewsForRepo, formatReviewsForPrompt } = require('./commit-review-store');
const { splitDiscordMessages } = require('./sales-support');

const DEV_SYSTEM = `Είσαι senior software engineer & tech lead για την ομάδα Emblem Tamiaki / TechFlow.
Βοηθάς developers να λύνουν bugs, να σχεδιάζουν features και να εκτελέσουν αλλαγές στον κώδικα.

ΣΤΟΧΟΣ: Πρακτική, εκτελέσιμη καθοδήγηση — όχι θεωρία. Ο συνάδελφος πρέπει να ξέρει τι να κάνει μετά την ανάγνωση.

ΚΑΝΟΝΕΣ:
- Βάσισε προτάσεις στο context που σου δίνεται (τεκμηρίωση, πρόσφατος κώδικας, αρχεία repo, commit reviews).
- Αν λείπουν στοιχεία, πες τι πρέπει να ελεγχθεί πριν την υλοποίηση — μην μαντεύεις APIs ή δομή που δεν φαίνονται.
- Πρότεινε συγκεκριμένα αρχεία/φακέλους όπου είναι λογικό (με βάση το context).
- Δώσε snippets κώδικα όταν βοηθούν (σύντομα, copy-paste ready, με σχόλια όπου χρειάζεται).
- Προτίμησε minimal, focused diffs — όχι over-engineering.
- Για React Native / MobX / clean architecture: σεβάσου stores → use cases → repositories.
- Για backend/integrations: σημείωσε edge cases, retries, idempotency όπου σχετικό.

ΔΟΜΗ ΑΠΑΝΤΗΣΗΣ (χρησιμοποίησε αυτά τα headings):

**Κατανόηση**
1-3 προτάσεις: τι ζητάει ο developer, τι υποθέτουμε.

**Προτεινόμενη προσέγγιση**
Η κύρια λύση σε 2-4 bullets. Γιατί αυτή και όχι άλλη.

**Βήματα εκτέλεσης**
Αριθμημένη λίστα βημάτων (clone branch → αρχεία → αλλαγές → tests → PR).

**Κώδικας / snippets**
Όπου χρήσιμο: παραδείγματα κώδικα σε fenced blocks με γλώσσα (typescript, kotlin, κλπ).
Μπορείς να δώσεις 1-3 εναλλακτικές προσεγγίσεις αν υπάρχουν trade-offs.

**Αρχεία που πιθανόν αγγίζουμε**
Bullet list με paths.

**Έλεγχοι & κίνδυνοι**
Τι να testάρεις, τι μπορεί να σπάσει, rollback plan αν χρειάζεται.

**Επόμενο βήμα**
Μία σαφής πρόταση: «Ξεκίνα με X» ή «Άνοιξε PR με Y».

Γλώσσα: απάντησε στην ίδια γλώσσα με την ερώτηση (Ελληνικά ή Αγγλικά). Τεχνικοί όροι/code στα Αγγλικά είναι OK.`;

const MAX_DEV_FILES = 12;
const MAX_FILE_CHARS = 6000;
const MAX_DEV_SCAN_CHARS = 45000;

const DEV_SCORE_RULES = [
  { re: /^src\/.+\.(tsx?|jsx?)$/i, score: 95 },
  { re: /^lib\/.+\.(tsx?|jsx?)$/i, score: 90 },
  { re: /^app\/.+\.(tsx?|jsx?)$/i, score: 90 },
  { re: /^components\/.+\.(tsx?|jsx?)$/i, score: 88 },
  { re: /^(stores|repositories|core)\/.+\.(tsx?|jsx?)$/i, score: 88 },
  { re: /^package\.json$/i, score: 85 },
  { re: /^tsconfig.*\.json$/i, score: 70 },
  { re: /^android\/.+\.(kt|java|gradle)$/i, score: 80 },
  { re: /^ios\/.+\.(swift|m)$/i, score: 80 },
  { re: /^docs\/.+\.md$/i, score: 75 },
  { re: /^readme\.md$/i, score: 75 },
  { re: /\.(tsx?|jsx?|kt|swift)$/i, score: 40 },
];

function scoreDevPath(filePath) {
  let score = 0;
  for (const rule of DEV_SCORE_RULES) {
    if (rule.re.test(filePath)) score = Math.max(score, rule.score);
  }
  return score;
}

function pickDevFiles(treePaths, query = '') {
  const queryTokens = String(query).toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  const filtered = filterTreePaths(treePaths, 500);

  return filtered
    .map((path) => {
      let score = scoreDevPath(path);
      const lower = path.toLowerCase();
      for (const token of queryTokens) {
        if (lower.includes(token)) score += 15;
      }
      return { path, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, MAX_DEV_FILES)
    .map((item) => item.path);
}

async function scanRepoDevContext(repoFullName, query = '') {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;

  const { client, repo } = createClientForFullName(token, repoFullName);
  const repoInfo = await client.getRepo(repo);
  const defaultBranch = repoInfo.default_branch;
  const { sha } = await client.getDefaultBranchSha(repo);
  const treePaths = await client.listTreePaths(repo, sha);
  const filesToRead = pickDevFiles(treePaths, query);

  if (!filesToRead.length && treePaths.includes('README.md')) {
    filesToRead.push('README.md');
  }

  const chunks = [];
  let total = 0;

  for (const filePath of filesToRead) {
    try {
      const file = await client.getFileContent(repo, filePath, defaultBranch);
      const body = file.content.slice(0, MAX_FILE_CHARS);
      const chunk = `--- ${filePath} ---\n${body}\n`;
      if (total + chunk.length > MAX_DEV_SCAN_CHARS) break;
      chunks.push(chunk);
      total += chunk.length;
    } catch {
      // skip unreadable files
    }
  }

  const structureSample = filterTreePaths(treePaths, 80).slice(0, 40).join('\n');

  return {
    repoFullName,
    defaultBranch,
    filesScanned: filesToRead,
    structureSample,
    content: chunks.join('\n') || '(No readable source files found.)',
  };
}

async function buildDevContext({ repoFullName, question, onProgress }) {
  const parts = [];

  if (onProgress) await onProgress('Συλλογή context από knowledge base & κώδικα…');

  const tasks = [];

  if (!isIndexEmpty()) {
    tasks.push(
      retrieveContext({ query: question, namespaces: ['wiki', 'commit-review', 'discord-capture'] })
        .then((r) => ({ type: 'retrieval', data: r }))
        .catch(() => ({ type: 'retrieval', data: null })),
    );
  }

  tasks.push(
    scanRepoDevContext(repoFullName, question)
      .then((r) => ({ type: 'repo', data: r }))
      .catch(() => ({ type: 'repo', data: null })),
  );

  if (isEmblemTameiakiRepo(repoFullName)) {
    tasks.push(
      fetchCodeActivity(repoFullName)
        .then((a) => ({ type: 'activity', data: a }))
        .catch(() => ({ type: 'activity', data: null })),
    );
  }

  const results = await Promise.all(tasks);
  let retrieval = null;
  let repoScan = null;
  let activity = null;

  for (const result of results) {
    if (result.type === 'retrieval') retrieval = result.data;
    if (result.type === 'repo') repoScan = result.data;
    if (result.type === 'activity') activity = result.data;
  }

  const reviews = getRecentReviewsForRepo(repoFullName, 15);

  if (retrieval?.content) {
    parts.push('## Σχετική τεκμηρίωση & γνώση (semantic retrieval)', retrieval.content);
  }

  if (repoScan) {
    parts.push(
      '## Δομή & αρχεία repository',
      `Repo: \`${repoScan.repoFullName}\` @ \`${repoScan.defaultBranch}\``,
      `Αρχεία που σαρώθηκαν: ${repoScan.filesScanned.join(', ') || '(none)'}`,
      '',
      '### Δέντρο (δείγμα)',
      repoScan.structureSample || '(n/a)',
      '',
      '### Περιεχόμενο αρχείων',
      repoScan.content,
    );
  }

  if (activity) {
    parts.push('## Πρόσφατη δραστηριότητα κώδικα', formatCodeActivityForPrompt(activity));
  }

  if (reviews.length) {
    parts.push('## AI commit reviews', formatReviewsForPrompt(reviews));
  }

  return {
    content: parts.join('\n\n'),
    sources: retrieval?.sources || [],
    repoScan,
    activity,
    reviewCount: reviews.length,
  };
}

async function runDevAssistant({ repoFullName, question, onProgress }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.DEV_ASSISTANT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o';
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set.');

  const trimmedQuestion = (question || '').trim();
  if (!trimmedQuestion) throw new Error('Question is required.');

  const context = await buildDevContext({ repoFullName, question: trimmedQuestion, onProgress });

  if (onProgress) await onProgress('Σύνταξη πλάνου υλοποίησης…');

  const userPrompt = [
    `Repository: ${repoFullName}`,
    '',
    '## Context',
    context.content || '(No context available — answer from general engineering best practices and flag assumptions.)',
    '',
    '## Developer question',
    trimmedQuestion,
    '',
    'Δώσε πλάνο εκτέλεσης με την καθορισμένη δομή. Πρακτικά snippets όπου βοηθούν.',
  ].join('\n');

  const { text } = await message({
    apiKey,
    model,
    system: DEV_SYSTEM,
    user: userPrompt,
    maxTokens: 4096,
    timeoutMs: 180000,
    onHeartbeat: onProgress
      ? () => onProgress('Ακόμα ετοιμάζεται το πλάνο…')
      : undefined,
  });

  const fullText = text.trim();
  const messages = splitDiscordMessages(fullText);
  return {
    content: messages[0],
    extraMessages: messages.slice(1),
    fullText,
    repoFullName,
    question: trimmedQuestion,
    sources: context.sources,
    filesScanned: context.repoScan?.filesScanned || [],
  };
}

module.exports = {
  runDevAssistant,
  buildDevContext,
  scanRepoDevContext,
  DEV_SYSTEM,
};
