/**
 * /leads — find company lead Excel files on Google Drive.
 * Primary: read-only Drive API + AI match. Fallback: n8n webhook.
 */

const { isLeadsDriveConfigured, listLeadSpreadsheets } = require('./leads-drive');
const { matchLeadSpreadsheet } = require('./leads-matcher');

const LEADS_N8N_WEBHOOK = process.env.LEADS_N8N_WEBHOOK || '';

function buildLeadsPayload({ question, channelId, user }) {
  return {
    source: 'slash',
    command: 'leads',
    question,
    channel_id: channelId,
    user: {
      id: user.id,
      username: user.username,
    },
  };
}

function formatLeadsReplyFromMatch(match) {
  const lines = [match.message.trim()];
  if (match.reason) lines.push(`_${match.reason}_`);
  if (match.fileName && match.fileUrl) {
    lines.push(`📄 **${match.fileName}**\n${match.fileUrl}`);
  } else if (match.fileUrl) {
    lines.push(match.fileUrl);
  }
  return lines.join('\n\n');
}

function formatLeadsReply(responseData, responseText) {
  if (responseData) {
    const message =
      responseData.message ||
      responseData.data?.content ||
      (typeof responseData.content === 'string' ? responseData.content : null);

    const fileUrl = responseData.fileUrl || responseData.driveUrl || responseData.url;
    const fileName = responseData.fileName || responseData.file_name;

    if (message || fileUrl) {
      const lines = [];
      if (message) lines.push(message.trim());
      if (responseData.reason) lines.push(`_${responseData.reason}_`);
      if (fileName && fileUrl) {
        lines.push(`📄 **${fileName}**\n${fileUrl}`);
      } else if (fileUrl) {
        lines.push(fileUrl);
      }
      return lines.join('\n\n');
    }
  }

  if (responseText?.trim()) {
    try {
      return formatLeadsReply(JSON.parse(responseText));
    } catch {
      return responseText.trim();
    }
  }

  return null;
}

async function forwardLeadsToN8n(payload) {
  const response = await fetch(LEADS_N8N_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let responseData = null;

  try {
    responseData = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseData = null;
  }

  return { ok: response.ok, status: response.status, responseText, responseData };
}

async function runLeadsLookupViaDrive(question) {
  const files = await listLeadSpreadsheets();
  const match = await matchLeadSpreadsheet({ question, files });
  return { content: formatLeadsReplyFromMatch(match) };
}

async function runLeadsLookupViaN8n({ question, channelId, user }) {
  const { ok, status, responseText, responseData } = await forwardLeadsToN8n(
    buildLeadsPayload({ question: question.trim(), channelId, user }),
  );

  if (!ok) {
    console.error(`[leads] n8n webhook failed (${status}): ${responseText}`);
    return {
      content: '❌ Αποτυχία επικοινωνίας με n8n. Έλεγξε ότι το workflow είναι ενεργό και τα logs.',
    };
  }

  const reply = formatLeadsReply(responseData, responseText);
  if (!reply) {
    console.error('[leads] n8n returned empty body:', responseText || '(empty)');
    return {
      content: '❌ Το n8n έτρεξε αλλά δεν επέστρεψε απάντηση. Έλεγξε executions στο n8n.',
    };
  }

  return { content: reply };
}

function buildNotConfiguredMessage() {
  return {
    content:
      '❌ Το `/leads` δεν είναι ρυθμισμένο ακόμα.\n'
      + 'Χρειάζεται Google service account (read-only) + κοινοποίηση του φακέλου leads.\n'
      + 'Δες `docs/leads-google-drive-setup.md`.',
  };
}

async function runLeadsLookup({ question, channelId, user }) {
  if (!question?.trim()) {
    return {
      content:
        'Γράψε την ερώτησή σου στο `question`, π.χ.\n'
        + '`/leads question:Ποιο αρχείο έχει τα leads για Emblem Tameiaki;`',
    };
  }

  const trimmed = question.trim();

  if (isLeadsDriveConfigured()) {
    try {
      return await runLeadsLookupViaDrive(trimmed);
    } catch (error) {
      console.error('[leads] Drive lookup failed:', error);
      if (LEADS_N8N_WEBHOOK) {
        console.log('[leads] falling back to n8n webhook…');
        return runLeadsLookupViaN8n({ question: trimmed, channelId, user });
      }
      return {
        content: `❌ Αποτυχία ανάγνωσης Google Drive: ${error.message}`,
      };
    }
  }

  if (LEADS_N8N_WEBHOOK) {
    return runLeadsLookupViaN8n({ question: trimmed, channelId, user });
  }

  return buildNotConfiguredMessage();
}

async function handleLeadsInteraction(interaction, hubSession = null) {
  const { createHubSession } = require('./assistant-hub-session');
  const session = hubSession || await createHubSession(interaction);
  const question = interaction.options.getString('question', true);

  await session.sendLoading('⏳ Αναζήτηση αρχείων leads στο Google Drive…');

  const result = await runLeadsLookup({
    question,
    channelId: interaction.channelId,
    user: interaction.user,
  });

  await session.sendMain(result.content);
}

module.exports = {
  buildLeadsPayload,
  formatLeadsReply,
  formatLeadsReplyFromMatch,
  forwardLeadsToN8n,
  runLeadsLookup,
  runLeadsLookupViaDrive,
  handleLeadsInteraction,
};
