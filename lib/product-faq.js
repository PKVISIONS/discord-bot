/**
 * Product FAQ loader and relevance matching for sales/support.
 */

const fs = require('fs');
const path = require('path');

const FAQ_DIR = path.join(__dirname, '..', 'data', 'faq');

/** Repo name (lowercase) → FAQ filename in data/faq/ */
const FAQ_BY_REPO = {
  emblemtameiaki: 'emblem-tamiaki.md',
};

const GREEK_STOPWORDS = new Set([
  'και', 'με', 'για', 'στο', 'στη', 'στα', 'στις', 'από', 'πως', 'τι', 'να', 'μου', 'μπορώ',
  'είναι', 'the', 'and', 'with', 'for', 'how', 'can', 'what',
]);

function parseFaqMarkdown(content) {
  const items = [];
  const lines = content.split('\n');
  let current = null;

  for (const line of lines) {
    const heading = line.match(/^##\s+(\d+)\.\s+(.+?)\s*;?\s*$/);
    if (heading) {
      if (current) items.push(current);
      current = {
        number: Number(heading[1]),
        question: heading[2].trim(),
        body: '',
      };
      continue;
    }

    if (current && line.trim()) {
      current.body += `${line.trim()}\n`;
    }
  }

  if (current) items.push(current);
  return items;
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

function scoreRelevance(employeeQuestion, faqItem) {
  const qTokens = new Set(tokenize(employeeQuestion));
  const faqTokens = tokenize(faqItem.question);
  if (!qTokens.size || !faqTokens.length) return 0;

  let overlap = 0;
  for (const token of faqTokens) {
    if (qTokens.has(token)) overlap += 1;
  }

  const qLower = employeeQuestion.toLowerCase();
  const fLower = faqItem.question.toLowerCase();
  if (qLower.includes('bluetooth') && fLower.includes('bluetooth')) overlap += 3;
  if (qLower.includes('mydata') && fLower.includes('mydata')) overlap += 3;
  if (qLower.includes('softpos') && fLower.includes('softpos')) overlap += 3;
  if (qLower.includes('ψπ') || qLower.includes('πελατολόγ')) {
    if (fLower.includes('ψπ') || fLower.includes('πελατολόγ')) overlap += 3;
  }
  if (qLower.includes('nexi') && fLower.includes('nexi')) overlap += 4;
  if (qLower.includes('cardlink') && fLower.includes('cardlink')) overlap += 4;
  if (qLower.includes('android') && fLower.includes('android')) overlap += 3;
  if (qLower.includes('ios') && fLower.includes('ios')) overlap += 3;
  if (qLower.includes('εκτυπ') && fLower.includes('εκτυπ')) overlap += 2;
  if (qLower.includes('offline') || qLower.includes('ίντερνετ') || qLower.includes('δίκτυο')) {
    if (fLower.includes('ίντερνετ') || fLower.includes('δίκτυο')) overlap += 3;
  }

  return overlap / Math.sqrt(faqTokens.length);
}

function resolveFaqPath(repoFullName) {
  const envPath = process.env.PRODUCT_FAQ_PATH || '';
  if (envPath && fs.existsSync(envPath)) return envPath;

  const repoName = (repoFullName || '').split('/').pop()?.toLowerCase() || '';
  const fileName = FAQ_BY_REPO[repoName];
  if (!fileName) return null;

  const fullPath = path.join(FAQ_DIR, fileName);
  return fs.existsSync(fullPath) ? fullPath : null;
}

function loadProductFaq(repoFullName) {
  const faqPath = resolveFaqPath(repoFullName);
  if (!faqPath) return { items: [], path: null, productName: null };

  const content = fs.readFileSync(faqPath, 'utf8');
  const title = content.match(/^#\s+(.+)/m)?.[1]?.trim() || 'Product FAQ';
  const items = parseFaqMarkdown(content);

  return {
    items,
    path: faqPath,
    productName: title.replace(/\s*—.*$/, '').trim(),
  };
}

function findRelevantFaqItems(employeeQuestion, faqItems, limit = 5) {
  if (!employeeQuestion?.trim() || !faqItems.length) return [];

  const scored = faqItems
    .map((item) => ({ item, score: scoreRelevance(employeeQuestion, item) }))
    .filter((entry) => entry.score > 0.35)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    const fallback = faqItems
      .map((item) => ({ item, score: scoreRelevance(employeeQuestion, item) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .filter((entry) => entry.score > 0);
    return fallback.map((e) => e.item);
  }

  return scored.slice(0, limit).map((entry) => entry.item);
}

function isBriefingRequest(employeeQuestion) {
  const q = (employeeQuestion || '').toLowerCase();
  return /ενημερωτικ|briefing|selling points|pitch|demo|υλικό πωλήσεων/.test(q);
}

function formatFaqCatalog(faqItems) {
  return faqItems
    .map((item) => `FAQ #${item.number}: ${item.question}`)
    .join('\n');
}

function formatRelevantFaqBlock(relevantItems) {
  if (!relevantItems.length) {
    return '(Δεν βρέθηκε σαφές ταίριασμα — χρησιμοποίησε το FAQ catalog και το repo.)';
  }

  return relevantItems
    .map((item) => {
      const body = item.body?.trim();
      return [
        `### FAQ #${item.number}`,
        `Ερώτηση πελάτη: ${item.question}`,
        body ? `Σημειώσεις FAQ: ${body}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

function detectResponseMode(employeeQuestion) {
  if (!employeeQuestion?.trim() || isBriefingRequest(employeeQuestion)) {
    return 'briefing';
  }
  return 'specific';
}

module.exports = {
  loadProductFaq,
  findRelevantFaqItems,
  detectResponseMode,
  formatFaqCatalog,
  formatRelevantFaqBlock,
  isBriefingRequest,
};
