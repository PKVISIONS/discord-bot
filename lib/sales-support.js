/**
 * Sales & customer support assistant for employees.
 */

const { message } = require('./openai');
const path = require('path');
const { scanRepoProductContext } = require('./repo-product-scanner');
const { getRecentReviewsForRepo, formatReviewsForPrompt } = require('./commit-review-store');
const {
  loadProductFaq,
  findRelevantFaqItems,
  detectResponseMode,
  formatFaqCatalog,
  formatRelevantFaqBlock,
} = require('./product-faq');
const {
  resolveKnowledgeRoot,
  buildKnowledgeContext,
  hasKnowledgeBase,
  getKnowledgeBranch,
} = require('./knowledge-base');
const { isEmblemTameiakiRepo } = require('./code-activity');
const { buildUnifiedEmblemContext } = require('./unified-emblem-context');
const {
  isVerifyEnabled,
  verifyAnswerGrounding,
  formatVerificationNote,
} = require('./answer-verify');

const SALES_SUPPORT_SYSTEM = `Είσαι senior ειδικός πωλήσεων και υποστήριξης για την Emblem Tamiaki. Βοηθάς εσωτερικούς συναδέλφους να απαντούν σε πελάτες — με ακρίβεια από την τεκμηρίωση, αλλά με λόγια που ακούγονται ανθρώπινα στον πελάτη.

ΔΥΟ ΕΠΙΠΕΔΑ (ποτέ μην τα μπερδεύεις):

**Α) Εσωτερικά για τον συνάδελφο** — σύντομα, μπορείς να είσαι πιο τεχνικός, να πεις τι να ελεγχθεί εσωτερικά. Μην βάζεις πηγές στο κείμενο — ο συνάδελφος μπορεί να απαντήσει στο μήνυμά σου για να τις δει.
**Β) Αυτό που λέει ο συνάδελφος στον πελάτη** — πάντα απλά, φιλικά, καθημερινά Ελληνικά. Σαν να μιλάς σε ιδιοκτήτη καταστήματος ή συνεργείου, όχι σε developer. Καμία αναφορά σε πηγές, αρχεία ή τεχνικά.

ΦΩΝΗ ΠΡΟΣ ΠΕΛΑΤΗ (το πιο σημαντικό):
- Απλές προτάσεις, ζεστός τόνος, χωρίς jargon.
- Όχι ονόματα αρχείων, όχι «βλέπε Integrations.md», όχι «FAQ #18», όχι commits, repos, APIs, app2app, endpoints, workflows.
- Όχι αναφορές σε «η τεκμηρίωση λέει», «σύμφωνα με το knowledge base», «από το review».
- Αντί για τεχνικά: πες τι κάνει ο πελάτης βήμα-βήμα με απλά λόγια («ανοίγετε Ρυθμίσεις → Εκτυπωτές» όχι «ρύθμιση encoding στο Bluetooth stack»).
- Νομικοί/φορολογικοί όροι (myDATA, Ψηφιακό Πελατολόγιο) μόνο αν ο πελάτης τους ξέρει ήδη — αλλιώς εξήγησέ τους απλά («η δήλωση στην ΑΑΔΕ», «το ηλεκτρονικό πελατολόγιο»).

ΠΗΓΕΣ:
Για Emblem Tamiaki έχεις ΕΝΙΑΙΟ προφίλ: τεκμηρίωση + πρόσφατος κώδικας (commits/PRs σε όλα τα branches) + AI commit reviews.
Χρησιμοποίησε και τα τρία μαζί. Αν κάτι νέο φαίνεται μόνο στον κώδικα, μπορεί να μην είναι ακόμα στα docs — πες το με επιφύλαξη στον πελάτη.
Οι πηγές δεν μπαίνουν στην απάντηση — ο συνάδελφος τις ζητάει απαντώντας στο μήνυμά σου (π.χ. «πηγές», «από πού το βρήκες;»). Όταν τις ζητήσει, δείξε καθαρά τα αρχεία του EmblemTameiaki-Knowledge με link στο GitHub.

ΤΕΚΜΗΡΙΩΣΗ & ΑΚΡΙΒΕΙΑ (κανόνας #1):
- Βάσισε ΚΑΘΕ ισχυρισμό στα στοιχεία που σου δίνονται στο εσωτερικό context. ΜΗΝ εφευρίσκεις δυνατότητες, τιμές, ή συμπεριφορές.
- Αν τα στοιχεία δεν επαρκούν ή είναι ασαφή, ΜΗΝ μαντεύεις: πες το ρητά στο «Σύντομα για εσένα» και βάλε στο «Αν δεν είσαι σίγουρος» τι πρέπει να επιβεβαιωθεί εσωτερικά.
- Αν η ερώτηση αφορά κάτι εκτός των στοιχείων, πες ότι χρειάζεται επιβεβαίωση από την ομάδα αντί να δώσεις αβέβαιη απάντηση στον πελάτη.

ΛΕΙΤΟΥΡΓΙΑ A — Συγκεκριμένη ερώτηση:
Δομή:
- **Σύντομα για εσένα** — 1-3 προτάσεις: τι ισχύει, τι να προσέξει ο συνάδελφος (μπορεί να είναι πιο τεχνικό ΕΔΩ μόνο)
- **Πες στον πελάτη έτσι** — 2-5 προτάσεις έτοιμες προς ανάγνωση/αποστολή. Φιλικές, σωστές, χωρίς τεχνικά. Αυτό είναι το κύριο deliverable.
- **Αν δεν είσαι σίγουρος** — τι να ρωτήσει εσωτερικά η ομάδα (χωρίς να το πει στον πελάτη)

ΛΕΙΤΟΥΡΓΙΑ B — Γενικό briefing:
- **Τι πουλάμε (με απλά λόγια)** — max 3 bullets για pitch προς πελάτη
- **Συχνές ερωτήσεις & τι απαντάς** — 5-7 ζευγάρια: «Αν ρωτήσει: …» → «Απαντάς: …» με φιλικό, μη-τεχνικό κείμενο στην απάντηση
- **Προσοχή εσωτερικά** — γνωστά θέματα/όρια (για τον συνάδελφο, όχι copy-paste στον πελάτη)

ΑΠΑΓΟΡΕΥΕΤΑΙ ΣΤΗΝ ΕΞΟΔΟ:
- Αναφορές σε .md, FAQ #, commit, repository, integration, API, module, branch στα κείμενα προς πελάτη
- Πηγές ή τεχνικές αναφορές μέσα στο «Πες στον πελάτη έτσι», «Τι πουλάμε», «Συχνές ερωτήσεις»
- Γενικό marketing pitch όταν ρωτήθηκες συγκεκριμένα
- Επανάληψη ίδιων φράσεων σε κάθε απάντηση
- Να εφευρίσκεις δυνατότητες

Πάντα Ελληνικά.`;

const DEFAULT_QUESTION =
  'Ετοίμασε σύντομο ενημερωτικό: τι λέμε στον πελάτη (απλά λόγια), 5-7 συχνές ερωτήσεις με έτοιμες φιλικές απαντήσεις χωρίς τεχνικά, και σύντομη εσωτερική σημείωση για γνωστά θέματα.';

const BRIEFING_FAQ_PRIORITY = [
  1, 3, 4, 9, 8, 17, 22, 18, 20, 21, 11, 6, 7, 15, 19,
];

function splitDiscordMessages(text, maxLen = 1900) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n\n', maxLen);
    if (cut < maxLen * 0.4) cut = rest.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.4) cut = maxLen;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function pickBriefingFaqItems(faqItems) {
  const byNumber = new Map(faqItems.map((item) => [item.number, item]));
  const picked = [];

  for (const num of BRIEFING_FAQ_PRIORITY) {
    if (byNumber.has(num)) picked.push(byNumber.get(num));
    if (picked.length >= 7) break;
  }

  if (picked.length < 5) {
    for (const item of faqItems) {
      if (picked.some((p) => p.number === item.number)) continue;
      picked.push(item);
      if (picked.length >= 7) break;
    }
  }

  return picked;
}

function buildModeInstructions(mode, relevantFaq, hasKnowledge) {
  if (mode === 'specific') {
    return [
      'Λειτουργία: A (συγκεκριμένη ερώτηση).',
      'Απάντησε ΜΟΝΟ στην ερώτηση. Το κύριο κομμάτι είναι «Πες στον πελάτη έτσι» — απλά, φιλικά, χωρίς τεχνικά.',
      'Μην συμπεριλάβεις πηγές — ο συνάδελφος μπορεί να τις ζητήσει απαντώντας στο μήνυμα.',
      hasKnowledge
        ? 'Χρησιμοποίησε την τεκμηρίωση για ακρίβεια, αλλά ΜΗΝ την αναφέρεις στο κείμενο προς πελάτη.'
        : null,
      relevantFaq.length
        ? 'Θέμα σχετικό με ερωτήσεις πελατών — απάντησε στο πνεύμα τους, χωρίς να γράψεις αριθμούς FAQ.'
        : null,
    ].filter(Boolean).join('\n');
  }

  return [
    'Λειτουργία: B (γενικό ενημερωτικό).',
    'Μορφή «Αν ρωτήσει → Απαντάς» με φιλικές απαντήσεις προς πελάτη. Όχι τεχνικά, όχι αναφορές σε docs.',
    'Μην συμπεριλάβεις πηγές — ο συνάδελφος μπορεί να τις ζητήσει απαντώντας στο μήνυμα.',
  ].join('\n');
}

function formatReviewSource(review) {
  const msg = (review.commitMessage || '').slice(0, 60);
  return `\`${review.branch}/${review.shortSha}\`${msg ? ` (${msg})` : ''}`;
}

const CONFIDENCE_LABELS = {
  high: 'Υψηλή (ισχυρή τεκμηρίωση)',
  medium: 'Μέτρια (επιβεβαίωσε πριν το πεις σίγουρα)',
  low: 'Χαμηλή (λίγα στοιχεία — ζήτα επιβεβαίωση)',
  none: 'Καμία (δεν βρέθηκαν στοιχεία στο index)',
};

const KNOWLEDGE_GITHUB_REPO = process.env.KNOWLEDGE_GITHUB_REPO
  || 'semantic-software/EmblemTameiaki-Knowledge';

function knowledgeDocRepoPath(sourcePath) {
  const normalized = String(sourcePath || '').replace(/\\/g, '/');
  return normalized.startsWith('docs/') ? normalized : `docs/${normalized}`;
}

function knowledgeDocGithubUrl(sourcePath, branch) {
  const docPath = knowledgeDocRepoPath(sourcePath);
  const ref = encodeURIComponent(branch || getKnowledgeBranch() || 'main');
  const encoded = docPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `https://github.com/${KNOWLEDGE_GITHUB_REPO}/blob/${ref}/${encoded}`;
}

function formatKnowledgeDocSource(sourcePath, title, branch) {
  const docPath = knowledgeDocRepoPath(sourcePath);
  const url = knowledgeDocGithubUrl(sourcePath, branch);
  const label = title && title !== sourcePath && title !== path.basename(sourcePath)
    ? ` — ${title}`
    : '';
  return `- [\`${docPath}\`](${url})${label}`;
}

function buildEmployeeSourceBlock({
  repoFullName,
  knowledgeDocs = [],
  knowledgeBranch,
  knowledgeRoot,
  faqNumbers = [],
  faqPath,
  emblemUnified = false,
  stats = null,
  mergedPrs = [],
  reviews = [],
  productContext = null,
  retrievalSources = [],
  confidence = null,
}) {
  const branchLabel = knowledgeBranch || getKnowledgeBranch() || 'main';
  const lines = ['**📚 Πηγές (εσωτερικά — μην προωθήσεις στον πελάτη)**'];

  const usedRetrieval = retrievalSources.length > 0;

  if (confidence && CONFIDENCE_LABELS[confidence]) {
    lines.push(`- **Εμπιστοσύνη απάντησης**: ${CONFIDENCE_LABELS[confidence]}`);
  }

  const knowledgeRepoLabel = knowledgeRoot
    ? path.basename(knowledgeRoot)
    : 'EmblemTameiaki-Knowledge';
  const knowledgeRepoUrl = `https://github.com/${KNOWLEDGE_GITHUB_REPO}`;
  const wikiSources = usedRetrieval
    ? retrievalSources.filter((s) => s.namespace === 'wiki' || s.namespace === 'faq')
    : [];
  const otherSources = usedRetrieval
    ? retrievalSources.filter((s) => s.namespace !== 'wiki' && s.namespace !== 'faq')
    : [];

  const knowledgePaths = usedRetrieval
    ? [...new Set(wikiSources.map((s) => s.sourcePath))]
    : [...new Set(knowledgeDocs)];

  if (knowledgePaths.length) {
    lines.push(
      '',
      `**EmblemTameiaki-Knowledge** — [${knowledgeRepoLabel}](${knowledgeRepoUrl}) @ \`${branchLabel}\``,
    );
    const titleByPath = new Map(
      wikiSources.map((s) => [s.sourcePath, s.title || s.sourcePath]),
    );
    for (const docPath of knowledgePaths) {
      lines.push(formatKnowledgeDocSource(docPath, titleByPath.get(docPath), branchLabel));
    }
  }

  if (!usedRetrieval && faqNumbers.length) {
    const faqLabel = faqPath ? path.basename(faqPath) : 'FAQ';
    lines.push('', `- **FAQ** (${faqLabel}): #${faqNumbers.join(', #')}`);
  }

  if (otherSources.length) {
    const grouped = {};
    for (const source of otherSources.slice(0, 12)) {
      (grouped[source.label] = grouped[source.label] || []).push(source);
    }
    lines.push('');
    for (const [label, items] of Object.entries(grouped)) {
      const rendered = items
        .map((s) => `${s.title || s.sourcePath}${s.url ? ` (${s.url})` : ''}`)
        .join('; ');
      lines.push(`- **${label}**: ${rendered}`);
    }
  }

  if (emblemUnified && stats) {
    lines.push(
      `- **Κώδικας GitHub** (\`${repoFullName}\`): ${stats.branches} branches · ${stats.commits} commits · ${stats.prs} merged PRs`,
    );
  }

  if (mergedPrs.length) {
    const prLines = mergedPrs
      .slice(0, 5)
      .map((pr) => `  - #${pr.number} \`${pr.branch}\` — ${pr.title}`)
      .join('\n');
    lines.push(`- **Πρόσφατα merged PRs**:\n${prLines}`);
  }

  if (!usedRetrieval && reviews.length) {
    lines.push(
      '',
      `- **AI commit reviews** (${reviews.length}): ${reviews.slice(0, 8).map(formatReviewSource).join('; ')}`,
    );
  }

  if (productContext?.filesScanned?.length) {
    lines.push(`- **Σάρωση repo** (\`${repoFullName}\`): ${productContext.filesScanned.join(', ')}`);
  }

  if (lines.length === 1) {
    lines.push('- (Δεν εντοπίστηκαν δομημένες πηγές — μόνο γενική γνώση μοντέλου.)');
  }

  return lines.join('\n');
}

function injectEmployeeSources(text, sourceBlock, mode) {
  if (!sourceBlock?.trim()) return text;

  if (mode === 'specific') {
    const markers = [
      '**Πες στον πελάτη έτσι**',
      '**Αν δεν είσαι σίγουρος**',
    ];
    for (const marker of markers) {
      const idx = text.indexOf(marker);
      if (idx >= 0) {
        return `${text.slice(0, idx).trimEnd()}\n\n${sourceBlock}\n\n${text.slice(idx)}`;
      }
    }
  } else {
    const internalMarker = '**Προσοχή εσωτερικά**';
    const internalIdx = text.indexOf(internalMarker);
    if (internalIdx >= 0) {
      const afterMarker = text.slice(internalIdx + internalMarker.length);
      const nextHeading = afterMarker.search(/\n\*\*[^*]/);
      if (nextHeading >= 0) {
        const insertAt = internalIdx + internalMarker.length + nextHeading;
        return `${text.slice(0, insertAt).trimEnd()}\n\n${sourceBlock}\n${text.slice(insertAt)}`;
      }
      return `${text.trimEnd()}\n\n${sourceBlock}`;
    }

    const customerMarker = '**Τι πουλάμε';
    const idx = text.indexOf(customerMarker);
    if (idx >= 0) {
      return `${sourceBlock}\n\n${text}`;
    }
  }

  return `${text.trimEnd()}\n\n${sourceBlock}`;
}

async function runSalesSupport({ repoFullName, question, onProgress }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o';
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set.');

  const employeeQuestion = (question || '').trim() || DEFAULT_QUESTION;
  const mode = detectResponseMode(employeeQuestion);
  const faq = loadProductFaq(repoFullName);

  const relevantFaq = mode === 'briefing'
    ? pickBriefingFaqItems(faq.items)
    : findRelevantFaqItems(employeeQuestion, faq.items, 4);

  const faqNumbers = relevantFaq.map((f) => f.number);
  const emblemUnified = isEmblemTameiakiRepo(repoFullName);
  const knowledgeRoot = resolveKnowledgeRoot(repoFullName);
  const useKnowledge = !!knowledgeRoot;

  if (onProgress) {
    await onProgress(
      emblemUnified
        ? 'Συγκέντρωση γνώσης + κώδικα EmblemTameiaki…'
        : useKnowledge
          ? 'Φόρτωση EmblemTameiaki-Knowledge…'
          : `Σάρωση του \`${repoFullName}\` για πληροφορίες προϊόντος…`,
    );
  }

  let unified = null;
  let knowledge = null;
  let reviews = [];
  let productContext = null;

  if (emblemUnified) {
    unified = await buildUnifiedEmblemContext({
      repoFullName,
      query: employeeQuestion,
      mode,
      faqNumbers,
      onProgress,
    });
  } else {
    knowledge = useKnowledge
      ? buildKnowledgeContext(knowledgeRoot, {
        query: employeeQuestion,
        mode,
        faqNumbers,
      })
      : null;

    reviews = getRecentReviewsForRepo(repoFullName, 12);
    reviews = reviews.map((r) => ({
      shortSha: r.shortSha,
      branch: r.branch,
      commitMessage: r.commitMessage,
    }));

    if (!useKnowledge) {
      productContext = await scanRepoProductContext(repoFullName);
    }
  }

  if (onProgress) {
    const label = mode === 'briefing' ? 'ενημερωτικού' : 'απάντησης';
    await onProgress(`Σύνταξη ${label} πωλήσεων & υποστήριξης…`);
  }

  const reviewBlock = emblemUnified ? null : formatReviewsForPrompt(reviews);
  const modeInstructions = buildModeInstructions(mode, relevantFaq, useKnowledge || emblemUnified);

  const userPrompt = [
    `Repository: ${repoFullName}`,
    faq.productName ? `Προϊόν: ${faq.productName}` : null,
    emblemUnified
      ? `Ενιαίο προφίλ: ${unified.branchCount} branches · ${unified.commitCount} commits · ${unified.mergedPrCount} PRs · ${unified.reviewCount} reviews`
      : null,
    '',
    '## Οδηγίες λειτουργίας',
    modeInstructions,
    '',
    '## [ΕΣΩΤΕΡΙΚΑ — μην αναφέρεις στην έξοδο] FAQ θέματα',
    formatRelevantFaqBlock(relevantFaq),
    '',
    '## [ΕΣΩΤΕΡΙΚΑ] FAQ κατάλογος',
    faq.items.length ? formatFaqCatalog(faq.items) : '(Δεν υπάρχει FAQ αρχείο.)',
    '',
    emblemUnified
      ? `## [ΕΣΩΤΕΡΙΚΑ] Ενιαίο προφίλ Emblem Tamiaki\n${unified.content}`
      : [
        useKnowledge
          ? `## [ΕΣΩΤΕΡΙΚΑ] EmblemTameiaki-Knowledge\n${knowledge.docPaths.join(', ')}\n\n${knowledge.content}`
          : '(Δεν βρέθηκε knowledge repo.)',
        productContext
          ? `## [ΕΣΩΤΕΡΙΚΑ] GitHub app repo\n${productContext.content}`
          : null,
        `## [ΕΣΩΤΕΡΙΚΑ] Commit reviews\n${reviewBlock}`,
      ].filter(Boolean).join('\n\n'),
    '',
    '## Ερώτηση συναδέλφου',
    employeeQuestion,
    '',
    'ΣΗΜΑΝΤΙΚΟ: Η έξοδος είναι για εσωτερικό συνάδελφο που θα μιλήσει σε πελάτη. Οι απαντήσεις προς πελάτη πρέπει να είναι απλές, φιλικές, χωρίς τεχνικά και χωρίς αναφορές σε αρχεία/docs/commits. Αποκλειστικά Ελληνικά.',
  ]
    .filter((line) => line !== null)
    .join('\n');

  const { text } = await message({
    apiKey,
    model,
    system: SALES_SUPPORT_SYSTEM,
    user: userPrompt,
    maxTokens: 4096,
    timeoutMs: 180000,
    onHeartbeat: onProgress
      ? () => onProgress('Ακόμα ετοιμάζεται η απάντηση…')
      : undefined,
  });

  let verification = null;
  if (isVerifyEnabled() && (emblemUnified || useKnowledge)) {
    if (onProgress) await onProgress('Έλεγχος ακρίβειας απάντησης…');
    const evidenceContent = emblemUnified
      ? unified?.content
      : [knowledge?.content, reviewBlock, productContext?.content].filter(Boolean).join('\n\n');
    verification = await verifyAnswerGrounding({ answer: text, evidence: evidenceContent });
  }

  const verificationNote = formatVerificationNote(verification);

  const sourceBlock = buildEmployeeSourceBlock({
    repoFullName,
    knowledgeDocs: unified?.knowledgeDocs || knowledge?.docPaths || [],
    knowledgeBranch: unified?.knowledgeBranch || knowledge?.knowledgeBranch || getKnowledgeBranch(),
    knowledgeRoot: unified?.knowledgeRoot || knowledgeRoot,
    faqNumbers,
    faqPath: faq.path,
    emblemUnified,
    stats: unified
      ? {
        branches: unified.branchCount,
        commits: unified.commitCount,
        prs: unified.mergedPrCount,
      }
      : null,
    mergedPrs: unified?.mergedPrs || [],
    reviews: unified?.reviews || reviews,
    productContext,
    retrievalSources: unified?.retrievalSources || [],
    confidence: unified?.confidence || null,
  });

  const finalSourceBlock = verificationNote
    ? `${sourceBlock}\n${verificationNote}`
    : sourceBlock;

  const messages = splitDiscordMessages(text.trim());
  return {
    content: messages[0],
    extraMessages: messages.slice(1),
    repoFullName,
    question: employeeQuestion,
    mode,
    sourceBlock: finalSourceBlock,
    verification,
    matchedFaq: faqNumbers,
    knowledgeDocs: unified?.knowledgeDocs || knowledge?.docPaths || [],
    knowledgeUsed: useKnowledge || emblemUnified,
    unified: emblemUnified,
    retrievalUsed: unified?.retrievalUsed || false,
    confidence: unified?.confidence || null,
    stats: unified
      ? {
        branches: unified.branchCount,
        commits: unified.commitCount,
        prs: unified.mergedPrCount,
        reviews: unified.reviewCount,
      }
      : null,
  };
}

module.exports = {
  runSalesSupport,
  SALES_SUPPORT_SYSTEM,
  DEFAULT_QUESTION,
  splitDiscordMessages,
  hasKnowledgeBase,
  buildEmployeeSourceBlock,
  injectEmployeeSources,
};
