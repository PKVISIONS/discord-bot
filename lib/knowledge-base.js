/**
 * Load and retrieve docs from EmblemTameiaki-Knowledge (local clone).
 * When KNOWLEDGE_REPO_BRANCH is set, reads that branch via git (no checkout needed).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const DEFAULT_KNOWLEDGE_PATH = path.join(
  os.homedir(),
  'Documents',
  'GitHub',
  'EmblemTameiaki-Knowledge',
);

const DEFAULT_KNOWLEDGE_BRANCH = 'restructure/wiki-structure';

const KNOWLEDGE_BY_REPO = {
  emblemtameiaki: true,
};

const MAX_DOCS_SPECIFIC = 8;
const MAX_DOCS_BRIEFING = 9;
const MAX_CHARS_PER_DOC = 7000;
const MAX_TOTAL_CHARS = 58000;

/** Legacy flat names → wiki-structure paths (and still work on main via endsWith). */
const DOC_ALIASES = {
  'Overview.md': ['product/overview.md'],
  'Glossary.md': ['product/glossary.md'],
  'Digital-Customers-FAQ.md': ['features/digital-customers-faq.md'],
  'Payments.md': ['integrations/payments-detail.md', 'integrations/payment-providers.md'],
  'Integrations.md': ['integrations/integrations-detail.md'],
  'Offline-Sync.md': ['architecture/offline-sync-detail.md', 'architecture/offline-first.md'],
  'Invoicing-Fiscal.md': ['features/invoicing-fiscal.md'],
  'Delivery-Notes.md': ['features/delivery-notes.md'],
  'User-Journeys.md': ['product/user-journeys.md'],
  'Cash-Register.md': ['features/cash-register.md'],
  'Document-Series-Reference.md': ['reference/document-series-reference.md'],
  'Digital-Customers.md': ['features/digital-customers.md'],
  'Settings-Reference.md': ['features/settings-reference.md'],
  'Ρυθμίσεις.md': ['product/βα_ρυθμισεις.md', 'features/ρυθμισεις-ba.md'],
  'features/CLOUD-974-Vehicle-Move-Purpose.md': ['features/cloud-974-vehicle-move-purpose.md'],
  'Delivery-Series-Guide.md': ['features/delivery-series-guide.md'],
  'Test-Guide-develop.md': ['development/test-guide-develop.md'],
  'Reports-Traders-Settings.md': ['features/reports-traders-settings.md'],
  'Cardlink.md': ['integrations/cardlink.md'],
  'cardlink.md': ['integrations/cardlink.md'],
};

const BRIEFING_DOCS = [
  'Overview.md',
  'Glossary.md',
  'Digital-Customers-FAQ.md',
  'Payments.md',
  'Integrations.md',
  'Offline-Sync.md',
  'Invoicing-Fiscal.md',
  'Delivery-Notes.md',
  'User-Journeys.md',
];

/** FAQ # → knowledge doc hints */
const FAQ_KNOWLEDGE_HINTS = {
  1: ['Overview.md'],
  2: ['Overview.md', 'User-Journeys.md'],
  3: ['Offline-Sync.md'],
  4: ['Overview.md', 'Cash-Register.md'],
  5: ['Invoicing-Fiscal.md', 'Document-Series-Reference.md'],
  6: ['Digital-Customers-FAQ.md', 'Offline-Sync.md', 'Digital-Customers.md'],
  7: ['Payments.md'],
  8: ['Payments.md', 'Integrations.md'],
  9: ['Offline-Sync.md', 'Invoicing-Fiscal.md'],
  10: ['Settings-Reference.md', 'Integrations.md'],
  11: ['Digital-Customers.md', 'features/CLOUD-974-Vehicle-Move-Purpose.md'],
  12: ['Delivery-Notes.md', 'Delivery-Series-Guide.md'],
  13: ['Invoicing-Fiscal.md'],
  14: ['Invoicing-Fiscal.md'],
  15: ['Integrations.md', 'Settings-Reference.md'],
  16: ['Integrations.md', 'Settings-Reference.md'],
  17: ['Integrations.md', 'Payments.md'],
  18: ['Integrations.md', 'Payments.md'],
  19: ['Settings-Reference.md', 'Integrations.md'],
  20: ['Overview.md', 'Test-Guide-develop.md'],
  21: ['Overview.md'],
  22: ['Integrations.md', 'Payments.md'],
  23: ['Settings-Reference.md', 'Integrations.md'],
  24: ['Settings-Reference.md'],
  25: ['Integrations.md', 'Payments.md'],
  26: ['Settings-Reference.md', 'Reports-Traders-Settings.md'],
  27: ['Cash-Register.md', 'Settings-Reference.md'],
  28: ['Digital-Customers.md', 'Settings-Reference.md'],
  29: ['Cash-Register.md', 'Reports-Traders-Settings.md'],
  30: ['Integrations.md', 'Cash-Register.md'],
  31: ['Cash-Register.md', 'Settings-Reference.md'],
};

const QUERY_TOPIC_HINTS = [
  { pattern: /offline|ίντερνετ|δίκτυο|σύνδεση/i, docs: ['Offline-Sync.md'] },
  { pattern: /mydata|παραστατικ|τιμολόγ|φορολογ|ζ\b/i, docs: ['Invoicing-Fiscal.md', 'Document-Series-Reference.md'] },
  { pattern: /ψπ|πελατολόγ|digital.?customer/i, docs: ['Digital-Customers-FAQ.md', 'Digital-Customers.md'] },
  { pattern: /softpos|pos|τερματικ|nexi|cardlink|worldline|mypos|app2app|πληρωμ/i, docs: ['Payments.md', 'Integrations.md', 'Ρυθμίσεις.md', 'Cardlink.md'] },
  { pattern: /cardlink|deeplink|payment.?connector|paymentconnector/i, docs: ['Cardlink.md', 'vendor/cardlink/deeplink-ecosystem.pdf', 'vendor/cardlink/payment-connector.pdf'] },
  { pattern: /edps|nbg.*tom|tap on tom|edps link/i, docs: ['Ρυθμίσεις.md', 'Payments.md', 'Settings-Reference.md'] },
  { pattern: /εκτυπ|bluetooth|printer|εκτυπωτ/i, docs: ['Settings-Reference.md', 'Integrations.md'] },
  { pattern: /δελτίο|αποστολ|delivery/i, docs: ['Delivery-Notes.md', 'Delivery-Series-Guide.md'] },
  { pattern: /ρυθμίσ|settings|χρήστες|χρήστη/i, docs: ['Settings-Reference.md', 'Reports-Traders-Settings.md'] },
  { pattern: /συνεργεί|φανοποι|αυτοκίνητ|όχημα/i, docs: ['Digital-Customers.md', 'features/CLOUD-974-Vehicle-Move-Purpose.md'] },
  { pattern: /scanner|barcode/i, docs: ['Integrations.md'] },
  { pattern: /android|ios/i, docs: ['Overview.md', 'Test-Guide-develop.md'] },
];

const GREEK_STOPWORDS = new Set([
  'και', 'με', 'για', 'στο', 'στη', 'από', 'πως', 'τι', 'να', 'μου', 'μπορώ', 'είναι', 'the', 'and', 'with',
]);

/** @type {{ root: string, branch: string|null, sha: string, docs: object[] }|null} */
let cache = null;

function getKnowledgeBranch() {
  const branch = (process.env.KNOWLEDGE_REPO_BRANCH || DEFAULT_KNOWLEDGE_BRANCH).trim();
  return branch || null;
}

function gitExec(knowledgeRoot, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', ['-C', knowledgeRoot, ...args], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function maybeFetchBranch(knowledgeRoot, branch) {
  if (process.env.KNOWLEDGE_REPO_FETCH !== 'true') return;

  try {
    gitExec(knowledgeRoot, ['fetch', 'origin', branch, '--quiet']);
  } catch (error) {
    console.warn(`[knowledge] git fetch origin ${branch} failed: ${error.message}`);
  }
}

function resolveGitRef(knowledgeRoot, branch) {
  maybeFetchBranch(knowledgeRoot, branch);

  const candidates = [`origin/${branch}`, branch];
  for (const ref of candidates) {
    const sha = gitExec(knowledgeRoot, ['rev-parse', '--verify', `${ref}^{commit}`], { allowFailure: true });
    if (sha) return { ref, sha };
  }

  throw new Error(
    `Knowledge branch "${branch}" not found in ${knowledgeRoot}. Run git fetch or check KNOWLEDGE_REPO_BRANCH.`,
  );
}

function resolveKnowledgeRoot(repoFullName) {
  const envPath = process.env.KNOWLEDGE_REPO_PATH || '';
  const repoName = (repoFullName || '').split('/').pop()?.toLowerCase() || '';

  if (!KNOWLEDGE_BY_REPO[repoName] && !envPath) return null;

  const candidates = [
    envPath,
    DEFAULT_KNOWLEDGE_PATH,
  ].filter(Boolean);

  for (const root of candidates) {
    const docsDir = path.join(root, 'docs');
    const gitDir = path.join(root, '.git');
    if (fs.existsSync(docsDir) || fs.existsSync(gitDir)) return root;
  }

  return null;
}

function normalizeRelativePath(relativePath) {
  return String(relativePath || '').replace(/^docs\//, '').replace(/\\/g, '/');
}

function expandDocHint(hint) {
  const aliases = DOC_ALIASES[hint];
  if (aliases) return [hint, ...aliases];
  return [hint];
}

function docMatchesHint(doc, hint) {
  const rel = doc.relativePath;
  const normalized = normalizeRelativePath(rel);

  return expandDocHint(hint).some((candidate) => {
    const c = normalizeRelativePath(candidate);
    return rel === candidate
      || rel.endsWith(candidate)
      || normalized === c
      || normalized.endsWith(c)
      || path.basename(rel).toLowerCase() === path.basename(c).toLowerCase();
  });
}

function findDocByHint(docs, hint) {
  return docs.find((doc) => docMatchesHint(doc, hint)) || null;
}

function walkMarkdownFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdownFiles(full, base));
    } else if (entry.name.endsWith('.md')) {
      files.push({
        relativePath: path.relative(base, full).replace(/\\/g, '/'),
        absolutePath: full,
      });
    }
  }

  return files;
}

function listMarkdownFilesFromGit(knowledgeRoot, gitRef) {
  // -z: null-terminated paths so non-ASCII filenames (e.g. βα_ρυθμισεις.md) are not
  // quoted/escaped by git and silently dropped by a naive .endsWith('.md') check.
  const output = gitExec(knowledgeRoot, ['ls-tree', '-r', '-z', '--name-only', gitRef, '--', 'docs']);
  return output
    .split('\0')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.md'))
    .map((repoPath) => ({
      repoPath,
      relativePath: normalizeRelativePath(repoPath),
    }));
}

function readMarkdownFromGit(knowledgeRoot, gitRef, repoPath) {
  return gitExec(knowledgeRoot, ['show', `${gitRef}:${repoPath}`]);
}

function extractTitle(content, relativePath) {
  const heading = content.match(/^#\s+(.+)/m);
  if (heading) return heading[1].trim();
  return path.basename(relativePath, '.md');
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\sα-ω]/gi, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !GREEK_STOPWORDS.has(t));
}

function buildDocRecord(relativePath, content) {
  return {
    relativePath: normalizeRelativePath(relativePath),
    title: extractTitle(content, relativePath),
    content,
    tokens: tokenize(`${relativePath} ${content}`),
  };
}

function loadKnowledgeIndexFromFilesystem(knowledgeRoot) {
  const docsDir = path.join(knowledgeRoot, 'docs');
  const mtime = fs.statSync(docsDir).mtimeMs;
  const files = walkMarkdownFiles(docsDir);

  const docs = files.map((file) => {
    const content = fs.readFileSync(file.absolutePath, 'utf8');
    return buildDocRecord(file.relativePath, content);
  });

  return { sha: String(mtime), branch: null, docs };
}

function loadKnowledgeIndexFromGit(knowledgeRoot, branch) {
  const { ref, sha } = resolveGitRef(knowledgeRoot, branch);
  const files = listMarkdownFilesFromGit(knowledgeRoot, ref);

  const docs = files.map((file) => {
    const content = readMarkdownFromGit(knowledgeRoot, ref, file.repoPath);
    return buildDocRecord(file.relativePath, content);
  });

  return { sha, branch: ref, docs };
}

function loadKnowledgeIndex(knowledgeRoot) {
  const branch = getKnowledgeBranch();

  if (branch) {
    const loaded = loadKnowledgeIndexFromGit(knowledgeRoot, branch);
    if (cache
      && cache.root === knowledgeRoot
      && cache.branch === loaded.branch
      && cache.sha === loaded.sha) {
      return cache.docs;
    }

    cache = {
      root: knowledgeRoot,
      branch: loaded.branch,
      sha: loaded.sha,
      docs: loaded.docs,
    };
    return loaded.docs;
  }

  const loaded = loadKnowledgeIndexFromFilesystem(knowledgeRoot);
  const cacheKey = `fs:${loaded.sha}`;

  if (cache && cache.root === knowledgeRoot && cache.sha === cacheKey) {
    return cache.docs;
  }

  cache = {
    root: knowledgeRoot,
    branch: null,
    sha: cacheKey,
    docs: loaded.docs,
  };
  return loaded.docs;
}

function scoreDocument(doc, query, faqNumbers = []) {
  const qTokens = new Set(tokenize(query));
  let score = 0;

  for (const token of doc.tokens) {
    if (qTokens.has(token)) score += 1;
  }

  score = score / Math.sqrt(doc.tokens.length || 1);

  for (const hint of QUERY_TOPIC_HINTS) {
    if (hint.pattern.test(query) && hint.docs.some((d) => docMatchesHint(doc, d))) {
      score += 8;
    }
  }

  for (const num of faqNumbers) {
    const hints = FAQ_KNOWLEDGE_HINTS[num] || [];
    if (hints.some((h) => docMatchesHint(doc, h))) score += 10;
  }

  if (docMatchesHint(doc, 'Digital-Customers-FAQ.md')) score += 2;
  if (docMatchesHint(doc, 'Glossary.md')) score += 1;

  return score;
}

function pickDocuments({ docs, query, mode, faqNumbers }) {
  if (mode === 'briefing') {
    const picked = [];

    for (const hint of BRIEFING_DOCS) {
      const doc = findDocByHint(docs, hint);
      if (doc) picked.push({ doc, score: 100 });
    }

    return picked.slice(0, MAX_DOCS_BRIEFING);
  }

  const scored = docs
    .map((doc) => ({ doc, score: scoreDocument(doc, query, faqNumbers) }))
    .filter((entry) => entry.score > 0.2)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return ['Overview.md', 'Digital-Customers-FAQ.md', 'Integrations.md']
      .map((hint) => findDocByHint(docs, hint))
      .filter(Boolean)
      .map((doc) => ({ doc, score: 1 }));
  }

  return scored.slice(0, MAX_DOCS_SPECIFIC);
}

function buildKnowledgeContext(knowledgeRoot, { query, mode, faqNumbers = [] }) {
  const docs = loadKnowledgeIndex(knowledgeRoot);
  const picked = pickDocuments({ docs, query, mode, faqNumbers });
  const branch = getKnowledgeBranch();

  const parts = [];
  let total = 0;
  const usedPaths = [];

  for (const { doc } of picked) {
    const chunk = `--- ${doc.relativePath} — ${doc.title} ---\n${doc.content.slice(0, MAX_CHARS_PER_DOC)}\n`;
    if (total + chunk.length > MAX_TOTAL_CHARS) break;
    parts.push(chunk);
    total += chunk.length;
    usedPaths.push(doc.relativePath);
  }

  return {
    content: parts.join('\n') || '(Δεν φορτώθηκε περιεχόμενο από το knowledge repo.)',
    docPaths: usedPaths,
    knowledgeRoot,
    knowledgeBranch: branch || 'working tree',
    docCount: usedPaths.length,
    totalDocsAvailable: docs.length,
  };
}

function hasKnowledgeBase(repoFullName) {
  return !!resolveKnowledgeRoot(repoFullName);
}

module.exports = {
  resolveKnowledgeRoot,
  loadKnowledgeIndex,
  buildKnowledgeContext,
  hasKnowledgeBase,
  getKnowledgeBranch,
  DEFAULT_KNOWLEDGE_PATH,
  DEFAULT_KNOWLEDGE_BRANCH,
};
