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

module.exports = {
  CATALOG,
  reportOpsError,
  seedDemoError,
  retryError,
  dismissOpsError,
  setN8nForwarder,
  isOpsGuiEnabled,
  opsGuiToken,
};
