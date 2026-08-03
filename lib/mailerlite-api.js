/**
 * Minimal MailerLite Connect API client (campaigns only).
 *
 * Auth: MAILERLITE_API_KEY (Bearer token from MailerLite → Integrations → API).
 * Only draft campaigns can be updated — MailerLite rejects edits on sent/scheduled ones.
 */

const BASE_URL = 'https://connect.mailerlite.com/api';

function mailerLiteApiKey() {
  return process.env.MAILERLITE_API_KEY || '';
}

function isMailerLiteConfigured() {
  return Boolean(mailerLiteApiKey());
}

async function request(method, apiPath, body) {
  const response = await fetch(`${BASE_URL}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${mailerLiteApiKey()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    // Some errors return empty bodies.
  }

  if (!response.ok) {
    const detail = data?.message || data?.error?.message || response.statusText;
    throw new Error(`MailerLite API ${response.status}: ${detail}`);
  }

  return data;
}

/**
 * Normalizes a MailerLite campaign resource into the flat shape the flow works with.
 */
function normalizeCampaign(raw) {
  if (!raw) return null;
  const email = raw.emails?.[0] || {};
  return {
    id: String(raw.id),
    name: raw.name || '',
    status: raw.status || '',
    subject: email.subject || '',
    fromName: email.from_name || '',
    fromEmail: email.from || '',
    replyTo: email.reply_to || '',
    content: email.content || '',
    updatedAt: raw.updated_at || raw.created_at || '',
  };
}

async function listDraftCampaigns({ limit = 25 } = {}) {
  const data = await request('GET', `/campaigns?filter[status]=draft&limit=${limit}`);
  return (data?.data || []).map(normalizeCampaign);
}

async function getCampaign(campaignId) {
  const data = await request('GET', `/campaigns/${encodeURIComponent(campaignId)}`);
  return normalizeCampaign(data?.data);
}

/**
 * MailerLite's PUT /campaigns/{id} expects the full payload (like create),
 * so callers pass the merged current+changed campaign.
 */
async function updateCampaign(campaign) {
  const payload = {
    name: campaign.name,
    type: 'regular',
    emails: [
      {
        subject: campaign.subject,
        from_name: campaign.fromName,
        from: campaign.fromEmail,
        ...(campaign.replyTo ? { reply_to: campaign.replyTo } : {}),
        ...(campaign.content ? { content: campaign.content } : {}),
      },
    ],
  };

  const data = await request('PUT', `/campaigns/${encodeURIComponent(campaign.id)}`, payload);
  return normalizeCampaign(data?.data);
}

module.exports = {
  isMailerLiteConfigured,
  listDraftCampaigns,
  getCampaign,
  updateCampaign,
};
