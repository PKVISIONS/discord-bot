/**
 * HTTP routes + static UI for the Ops error GUI (customer trial).
 */

const fs = require('fs');
const path = require('path');
const { listErrors, getError } = require('./ops-error-store');
const {
  isOpsGuiEnabled,
  opsGuiToken,
  seedDemoError,
  retryError,
  dismissOpsError,
} = require('./ops-errors');

const GUI_ROOT = path.join(__dirname, '..', 'ops-gui');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function unauthorized(res) {
  sendJson(res, 401, { ok: false, error: 'Unauthorized — set OPS_GUI_TOKEN or pass ?token=' });
}

function checkAuth(req, url) {
  const expected = opsGuiToken();
  if (!expected) return true;
  const header = req.headers['x-ops-token'] || '';
  const queryToken = url.searchParams.get('token') || '';
  return header === expected || queryToken === expected;
}

function publicError(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    status: entry.status,
    source: entry.source,
    automation: entry.automation,
    code: entry.code,
    title: entry.title,
    meaning: entry.meaning,
    detail: entry.detail,
    retryable: entry.retryable,
    context: entry.context
      ? {
          username: entry.context.username || null,
          channelId: entry.context.channelId || null,
          source: entry.context.source || null,
        }
      : null,
  };
}

async function handleOpsApi(req, res, url) {
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/ops/api/health') {
    sendJson(res, 200, { ok: true, gui: true });
    return true;
  }

  if (req.method === 'GET' && pathname === '/ops/api/errors') {
    const status = url.searchParams.get('status') || 'open';
    const entries = listErrors({ status: status === 'all' ? undefined : status }).map(publicError);
    sendJson(res, 200, { ok: true, errors: entries });
    return true;
  }

  if (req.method === 'POST' && pathname === '/ops/api/errors/demo') {
    const entry = seedDemoError();
    sendJson(res, 201, { ok: true, error: publicError(entry) });
    return true;
  }

  const dismissMatch = pathname.match(/^\/ops\/api\/errors\/([^/]+)\/dismiss$/);
  if (req.method === 'POST' && dismissMatch) {
    const result = dismissOpsError(dismissMatch[1]);
    if (!result.ok) {
      sendJson(res, 404, result);
      return true;
    }
    sendJson(res, 200, { ok: true, error: publicError(result.entry) });
    return true;
  }

  const retryMatch = pathname.match(/^\/ops\/api\/errors\/([^/]+)\/retry$/);
  if (req.method === 'POST' && retryMatch) {
    const before = getError(retryMatch[1]);
    if (!before) {
      sendJson(res, 404, { ok: false, error: 'Error not found' });
      return true;
    }
    const result = await retryError(retryMatch[1]);
    sendJson(res, result.ok ? 200 : 400, result);
    return true;
  }

  return false;
}

function serveStatic(req, res, url) {
  let rel = url.pathname.replace(/^\/ops\/?/, '');
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  if (rel.includes('..')) {
    res.writeHead(400);
    res.end('Bad path');
    return true;
  }

  const filePath = path.join(GUI_ROOT, rel);
  if (!filePath.startsWith(GUI_ROOT)) {
    res.writeHead(400);
    res.end('Bad path');
    return true;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

/**
 * @returns {Promise<boolean>} true if the request was handled
 */
async function tryHandleOpsRequest(req, res) {
  if (!isOpsGuiEnabled()) return false;

  const host = req.headers.host || 'localhost';
  let url;
  try {
    url = new URL(req.url || '/', `http://${host}`);
  } catch {
    return false;
  }

  if (!url.pathname.startsWith('/ops')) return false;

  if (!checkAuth(req, url)) {
    unauthorized(res);
    return true;
  }

  if (url.pathname.startsWith('/ops/api/')) {
    const handled = await handleOpsApi(req, res, url);
    if (handled) return true;
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return true;
  }

  if (req.method === 'GET' && serveStatic(req, res, url)) return true;

  if (req.method === 'GET' && (url.pathname === '/ops' || url.pathname === '/ops/')) {
    const index = path.join(GUI_ROOT, 'index.html');
    if (fs.existsSync(index)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      fs.createReadStream(index).pipe(res);
      return true;
    }
  }

  res.writeHead(404);
  res.end('Not found');
  return true;
}

// keep readBody export unused warning away — available for future POST bodies
module.exports = {
  tryHandleOpsRequest,
  isOpsGuiEnabled,
  readBody,
  GUI_ROOT,
};
