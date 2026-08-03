/**
 * Channel → MailerLite campaign bindings (data/mailerlite-channel-bindings.json).
 *
 * A channel is bound with a natural-language message ("bot, work on Spring Sale here");
 * all subsequent edit requests in that channel target the bound draft campaign.
 */

const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', 'data', 'mailerlite-channel-bindings.json');

function loadStore() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    return { bindings: {} };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return { bindings: parsed.bindings || {} };
  } catch {
    return { bindings: {} };
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function getBinding(channelId) {
  const store = loadStore();
  return store.bindings[String(channelId)] || null;
}

function setBinding(channelId, { campaignId, campaignName, boundBy }) {
  const store = loadStore();
  store.bindings[String(channelId)] = {
    campaignId: String(campaignId),
    campaignName: campaignName || '',
    boundBy: boundBy ? String(boundBy) : '',
    boundAt: new Date().toISOString(),
  };
  saveStore(store);
}

function clearBinding(channelId) {
  const store = loadStore();
  const existed = Boolean(store.bindings[String(channelId)]);
  delete store.bindings[String(channelId)];
  if (existed) saveStore(store);
  return existed;
}

module.exports = {
  getBinding,
  setBinding,
  clearBinding,
  STORE_PATH,
};
