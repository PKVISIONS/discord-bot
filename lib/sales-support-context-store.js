/**
 * Links Discord message IDs → sales-support source metadata (for reply-to-ask-sources).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_PATH = path.join(__dirname, '..', 'data', 'sales-support-contexts.json');
const MAX_ENTRIES = 400;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function loadStore() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    return { entries: {}, messageIndex: {} };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return {
      entries: parsed.entries || {},
      messageIndex: parsed.messageIndex || {},
    };
  } catch {
    return { entries: {}, messageIndex: {} };
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function pruneStore(store) {
  const now = Date.now();

  for (const [id, entry] of Object.entries(store.entries)) {
    const age = now - new Date(entry.createdAt || 0).getTime();
    if (age > TTL_MS) {
      for (const messageId of entry.messageIds || []) {
        delete store.messageIndex[messageId];
      }
      delete store.entries[id];
    }
  }

  const ids = Object.keys(store.entries);
  if (ids.length > MAX_ENTRIES) {
    const sorted = ids.sort(
      (a, b) => new Date(store.entries[a].createdAt).getTime() - new Date(store.entries[b].createdAt).getTime(),
    );
    for (const id of sorted.slice(0, ids.length - MAX_ENTRIES)) {
      for (const messageId of store.entries[id].messageIds || []) {
        delete store.messageIndex[messageId];
      }
      delete store.entries[id];
    }
  }
}

function saveSalesSupportContext({
  userId,
  repoFullName,
  question,
  sourceBlock,
}) {
  const store = loadStore();
  pruneStore(store);

  const id = crypto.randomUUID();
  const entry = {
    id,
    userId: String(userId),
    repoFullName,
    question: question || '',
    sourceBlock: sourceBlock || '',
    messageIds: [],
    createdAt: new Date().toISOString(),
  };

  store.entries[id] = entry;
  saveStore(store);
  return id;
}

function linkMessageToContext(contextId, messageId) {
  if (!contextId || !messageId) return;

  const store = loadStore();
  const entry = store.entries[contextId];
  if (!entry) return;

  if (!entry.messageIds.includes(messageId)) {
    entry.messageIds.push(messageId);
  }
  store.messageIndex[String(messageId)] = contextId;
  saveStore(store);
}

function getContextByMessageId(messageId) {
  const store = loadStore();
  const contextId = store.messageIndex[String(messageId)];
  if (!contextId) return null;
  return store.entries[contextId] || null;
}

async function findContextForReply(message) {
  const refId = message.reference?.messageId;
  if (!refId || !message.channel) return null;

  let currentId = refId;
  const visited = new Set();

  for (let hop = 0; hop < 8 && currentId; hop += 1) {
    if (visited.has(currentId)) break;
    visited.add(currentId);

    const context = getContextByMessageId(currentId);
    if (context?.sourceBlock) return context;

    let refMsg;
    try {
      refMsg = await message.channel.messages.fetch(currentId);
    } catch {
      break;
    }

    currentId = refMsg.reference?.messageId || null;
  }

  return null;
}

module.exports = {
  saveSalesSupportContext,
  linkMessageToContext,
  getContextByMessageId,
  findContextForReply,
  STORE_PATH,
};
