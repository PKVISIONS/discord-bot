/**
 * Ops error reporter + retry helpers for the customer GUI trial.
 *
 * Goal: turn bot/n8n failures into plain-language cards non-devs can act on.
 */

const { addError, getError, resolveError, dismissError } = require('./ops-error-store');

const CATALOG = {
  n8n_unreachable: {
    title: 'Linear automation could not be reached',
    meaning:
      'The bot tried to run a Linear request through n8n, but n8n did not answer. Often the workflow is inactive or the webhook URL is wrong.',
    automation: 'Linear via n8n',
    retryable: true,
    retryKind: 'n8n',
  },
  n8n_empty: {
    title: 'Linear automation finished with no reply',
    meaning:
      'n8n ran, but it did not return a message for Discord. Someone may need to check the last n8n execution for that workflow.',
    automation: 'Linear via n8n',
    retryable: true,
    retryKind: 'n8n',
  },
  n8n_handler: {
    title: 'Linear request failed while processing',
    meaning:
      'The Discord → Linear command crashed before a normal reply. Retrying often works after a brief outage.',
    automation: 'Linear via n8n',
    retryable: true,
    retryKind: 'n8n',
  },
  deploy_failed: {
    title: 'Deploy could not be started',
    meaning:
      'GitHub rejected or could not accept the build trigger. Common causes: missing GitHub token permissions, or a wrong branch name.',
    automation: 'Deploy (/deploy)',
    retryable: false,
    retryKind: null,
  },
  plan_execute_failed: {
    title: 'Approved plan could not finish',
    meaning:
      'The bot started executing an approved GitHub plan, but it stopped before opening a pull request. Check GitHub token and OpenAI access.',
    automation: 'GitHub plan execute',
    retryable: false,
    retryKind: null,
  },
  demo: {
    title: 'Sample error (demo)',
    meaning:
      'This is a fake error so you can try Dismiss and Retry without waiting for a real failure.',
    automation: 'Ops GUI demo',
    retryable: true,
    retryKind: 'demo',
  },
};

let n8nForwarder = null;

function setN8nForwarder(fn) {
  n8nForwarder = typeof fn === 'function' ? fn : null;
}

function reportOpsError(code, extras = {}) {
  const template = CATALOG[code] || {
    title: 'Automation failed',
    meaning: 'Something went wrong in the Discord bot automation. Check the bridge logs if it keeps happening.',
    automation: 'Discord bot',
    retryable: false,
    retryKind: null,
  };

  const entry = addError({
    code,
    source: extras.source || code.split('_')[0] || 'bot',
    title: extras.title || template.title,
    meaning: extras.meaning || template.meaning,
    automation: extras.automation || template.automation,
    detail: extras.detail || '',
    retryable: extras.retryable != null ? extras.retryable : template.retryable,
    retryKind: extras.retryKind != null ? extras.retryKind : template.retryKind,
    retryPayload: extras.retryPayload || null,
    context: extras.context || null,
  });

  console.warn(`[ops-error] ${entry.id} ${entry.code}: ${entry.title}`);
  return entry;
}

function seedDemoError() {
  return reportOpsError('demo', {
    source: 'demo',
    detail: 'Created from the Ops GUI “Add sample error” action.',
    retryPayload: { demo: true },
  });
}

async function retryError(id) {
  const entry = getError(id);
  if (!entry) return { ok: false, error: 'Error not found' };
  if (entry.status !== 'open') return { ok: false, error: 'Only open errors can be retried' };
  if (!entry.retryable) return { ok: false, error: 'This error cannot be retried from the GUI' };

  if (entry.retryKind === 'demo') {
    resolveError(id, 'Demo retry succeeded');
    return { ok: true, message: 'Demo retry succeeded — marked as fixed.' };
  }

  if (entry.retryKind === 'n8n') {
    if (!n8nForwarder) {
      return { ok: false, error: 'Retry is not wired yet (n8n forwarder missing)' };
    }
    if (!entry.retryPayload) {
      return { ok: false, error: 'No saved request to retry' };
    }

    try {
      const result = await n8nForwarder(entry.retryPayload);
      if (!result?.ok) {
        const detail = `Retry HTTP ${result?.status || '?'}: ${String(result?.responseText || '').slice(0, 400)}`;
        reportOpsError('n8n_unreachable', {
          detail,
          retryPayload: entry.retryPayload,
          context: entry.context,
        });
        return { ok: false, error: 'Retry failed — a new open error was logged.' };
      }

      const replyText = typeof result.responseText === 'string' ? result.responseText.trim() : '';
      if (!replyText && !result.responseData) {
        reportOpsError('n8n_empty', {
          detail: 'Retry returned an empty body',
          retryPayload: entry.retryPayload,
          context: entry.context,
        });
        return { ok: false, error: 'Retry reached n8n but got an empty reply.' };
      }

      resolveError(id, 'Retried successfully from Ops GUI');
      return { ok: true, message: 'Retry succeeded — marked as fixed.' };
    } catch (error) {
      reportOpsError('n8n_handler', {
        detail: error.message || String(error),
        retryPayload: entry.retryPayload,
        context: entry.context,
      });
      return { ok: false, error: error.message || 'Retry failed' };
    }
  }

  return { ok: false, error: `Unknown retry kind: ${entry.retryKind}` };
}

function dismissOpsError(id) {
  const updated = dismissError(id);
  if (!updated) return { ok: false, error: 'Error not found' };
  return { ok: true, entry: updated };
}

function isOpsGuiEnabled() {
  return process.env.OPS_GUI_ENABLED !== 'false';
}

function opsGuiToken() {
  return process.env.OPS_GUI_TOKEN || '';
}

function getOpsGuiPublicBaseUrl() {
  if (process.env.WEBHOOK_PUBLIC_URL) {
    return String(process.env.WEBHOOK_PUBLIC_URL).replace(/\/$/, '');
  }
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  // Railway sometimes exposes the service URL this way
  if (process.env.RAILWAY_STATIC_URL) {
    return `https://${String(process.env.RAILWAY_STATIC_URL).replace(/^https?:\/\//, '')}`;
  }
  const port = process.env.PORT || process.env.WEBHOOK_PORT || '3847';
  return `http://localhost:${port}`;
}

/** Full /ops URL for Discord messages (includes token when configured). */
function getOpsGuiPublicUrl() {
  if (!isOpsGuiEnabled()) return null;
  const base = `${getOpsGuiPublicBaseUrl()}/ops/`;
  const token = opsGuiToken();
  if (!token) return base;
  return `${base}?token=${encodeURIComponent(token)}`;
}

function formatN8nFailureReply(kind = 'unreachable') {
  const url = getOpsGuiPublicUrl();
  const head =
    kind === 'empty'
      ? 'Η αυτοματοποίηση Linear (n8n) τελείωσε χωρίς απάντηση.'
      : 'Κάτι πήγε στραβά στην αυτοματοποίηση Linear (n8n).';

  if (!url) {
    return `${head}\nΈλεγξε τα logs του bot ή το n8n.`;
  }

  return (
    `${head}\n`
    + `Άνοιξε την απλή σελίδα προβλημάτων (χωρίς n8n): ${url}\n`
    + `_Εκεί θα δεις τι χάλασε σε απλά λόγια και μπορείς να πατήσεις Retry._`
  );
}

/**
 * Intentionally call a broken webhook so we exercise the real n8n-unreachable path.
 * Does not touch the live N8N_WEBHOOK URL.
 */
async function runIntentionalN8nFailureTest({ username, channelId, source = 'ops-test' } = {}) {
  const liveWebhook = process.env.N8N_WEBHOOK || '';
  // Hit a URL that cannot succeed — same host family as live webhook when possible,
  // otherwise a public 503 stub. This mimics "n8n webhook down / wrong path".
  let failUrl = 'https://httpstat.us/503';
  if (liveWebhook) {
    try {
      const u = new URL(liveWebhook);
      u.pathname = `${u.pathname.replace(/\/$/, '')}/__ops-test-intentional-fail__`;
      failUrl = u.toString();
    } catch {
      // keep stub
    }
  }

  const payload = {
    content: '__OPS_TEST_INTENTIONAL_FAIL__',
    userId: 'ops-test',
    username: username || 'ops-test',
    channelId: channelId || null,
    source,
  };

  let status = 0;
  let responseText = '';
  try {
    const response = await fetch(failUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    status = response.status;
    responseText = await response.text();
  } catch (error) {
    status = 0;
    responseText = error.message || String(error);
  }

  const entry = reportOpsError('n8n_unreachable', {
    title: 'Linear automation could not be reached (test)',
    meaning:
      'This was an intentional test failure. The bot pretended n8n was unreachable so you can try the Ops page and Retry/Dismiss.',
    detail: `Intentional ops-test → HTTP ${status || 'network-error'}: ${String(responseText || '').slice(0, 400)}\nFail URL: ${failUrl}`,
    retryable: true,
    retryKind: 'demo',
    retryPayload: payload,
    context: { username, channelId, source },
  });

  return {
    entry,
    reply: formatN8nFailureReply('unreachable'),
    failUrl,
    status,
  };
}

module.exports = {
  CATALOG,
  reportOpsError,
  seedDemoError,
  retryError,
  dismissOpsError,
  setN8nForwarder,
  isOpsGuiEnabled,
  opsGuiToken,
  getOpsGuiPublicBaseUrl,
  getOpsGuiPublicUrl,
  formatN8nFailureReply,
  runIntentionalN8nFailureTest,
};
