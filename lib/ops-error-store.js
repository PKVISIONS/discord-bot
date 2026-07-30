/**
 * Persistent store for customer-facing ops errors (GUI error handler trial).
 *
 * Layout: data/ops-errors.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_PATH = path.join(__dirname, '..', 'data', 'ops-errors.json');
const MAX_ENTRIES = 200;

function emptyStore() {
  return { entries: [] };
}

function loadStore() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  if (!fs.existsSync(STORE_PATH)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return emptyStore();
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const trimmed = {
    entries: store.entries.slice(0, MAX_ENTRIES),
  };
  fs.writeFileSync(STORE_PATH, JSON.stringify(trimmed, null, 2), 'utf8');
}

function listErrors({ status } = {}) {
  const { entries } = loadStore();
  const filtered = status
    ? entries.filter((e) => e.status === status)
    : entries;
  return filtered.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function getError(id) {
  return loadStore().entries.find((e) => e.id === id) || null;
}

function addError(input) {
  const store = loadStore();
  const entry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'open',
    source: input.source || 'bot',
    automation: input.automation || 'Discord bot',
    code: input.code || 'unknown',
    title: input.title || 'Something went wrong',
    meaning: input.meaning || 'An automation failed. A teammate may need to check the bot or n8n.',
    detail: input.detail || '',
    retryable: Boolean(input.retryable),
    retryKind: input.retryKind || null,
    retryPayload: input.retryPayload || null,
    context: input.context || null,
  };
  store.entries.unshift(entry);
  saveStore(store);
  return entry;
}

function updateError(id, patch) {
  const store = loadStore();
  const idx = store.entries.findIndex((e) => e.id === id);
  if (idx < 0) return null;
  store.entries[idx] = {
    ...store.entries[idx],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  saveStore(store);
  return store.entries[idx];
}

function dismissError(id) {
  return updateError(id, { status: 'dismissed' });
}

function resolveError(id, note) {
  return updateError(id, {
    status: 'resolved',
    resolveNote: note || null,
  });
}

module.exports = {
  listErrors,
  getError,
  addError,
  updateError,
  dismissError,
  resolveError,
  STORE_PATH,
};
