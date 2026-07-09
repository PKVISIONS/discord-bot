/**
 * Optional second-pass factuality check (flag ANSWER_VERIFY=true).
 *
 * A cheap model call that checks whether the drafted answer's factual claims
 * are supported by the retrieved evidence. Returns any unsupported claims so
 * the caller can surface an internal caution (never shown to the customer).
 */

const { message } = require('./openai');

const VERIFY_SYSTEM = `Είσαι ελεγκτής ακρίβειας. Θα λάβεις (1) στοιχεία/τεκμηρίωση και (2) μια προσχέδιο απάντηση.
Έλεγξε ΜΟΝΟ αν οι ουσιαστικοί ισχυρισμοί της απάντησης (δυνατότητες, τιμές, βήματα, συμπεριφορά προϊόντος) υποστηρίζονται από τα στοιχεία.
Αγνόησε φιλικές φράσεις, χαιρετισμούς, γενικό τόνο.
Απάντησε ΜΟΝΟ με JSON: {"supported": true|false, "issues": ["σύντομη περιγραφή κάθε μη-τεκμηριωμένου ισχυρισμού"]}.
Αν όλα υποστηρίζονται, βάλε "issues": [].`;

function isVerifyEnabled() {
  return String(process.env.ANSWER_VERIFY || '').toLowerCase() === 'true';
}

function safeParse(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{ supported: boolean, issues: string[] } | null>}
 */
async function verifyAnswerGrounding({
  answer,
  evidence,
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.ANSWER_VERIFY_MODEL || 'gpt-4o-mini',
}) {
  if (!answer?.trim() || !evidence?.trim() || !apiKey) return null;

  const evidenceTrimmed = evidence.length > 45000 ? evidence.slice(0, 45000) : evidence;

  try {
    const { text } = await message({
      apiKey,
      model,
      system: VERIFY_SYSTEM,
      user: [
        '## Στοιχεία / Τεκμηρίωση',
        evidenceTrimmed,
        '',
        '## Προσχέδιο απάντησης',
        answer,
      ].join('\n'),
      maxTokens: 600,
      timeoutMs: 60000,
    });

    const parsed = safeParse(text);
    if (!parsed) return null;
    return {
      supported: parsed.supported !== false && !(parsed.issues || []).length,
      issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 6) : [],
    };
  } catch {
    return null;
  }
}

function formatVerificationNote(verification) {
  if (!verification || verification.supported) return null;
  if (!verification.issues.length) return null;
  return [
    '- **⚠ Έλεγχος ακρίβειας**: κάποιοι ισχυρισμοί ίσως δεν τεκμηριώνονται πλήρως — επιβεβαίωσε πριν τα πεις στον πελάτη:',
    ...verification.issues.map((issue) => `  - ${issue}`),
  ].join('\n');
}

module.exports = {
  isVerifyEnabled,
  verifyAnswerGrounding,
  formatVerificationNote,
};
