/**
 * Hub channels where /sales-support opens a dedicated public thread per session.
 */

function getAssistantHubChannelIds() {
  const raw = process.env.ASSISTANT_HUB_CHANNELS
    || process.env.KNOWLEDGE_CAPTURE_CHANNELS
    || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function isAssistantHubChannel(channelId) {
  if (!channelId) return false;
  return getAssistantHubChannelIds().includes(String(channelId));
}

module.exports = {
  getAssistantHubChannelIds,
  isAssistantHubChannel,
};
