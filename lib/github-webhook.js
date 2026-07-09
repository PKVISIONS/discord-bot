/**
 * GitHub webhook signature verification.
 */

const crypto = require('crypto');

function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret) return false;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const received = signatureHeader.slice('sha256='.length);

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(received, 'hex'),
    );
  } catch {
    return false;
  }
}

function isPushEvent(payload) {
  return payload && typeof payload === 'object' && payload.ref && Array.isArray(payload.commits);
}

function parsePushEvent(payload) {
  if (!isPushEvent(payload)) return null;

  const deleted = payload.deleted === true;
  const repoFullName = payload.repository?.full_name || '';
  const branch = (payload.ref || '').replace(/^refs\/heads\//, '');
  const pusher = payload.pusher?.name || payload.sender?.login || 'unknown';
  const compareUrl = payload.compare || '';

  const commits = (payload.commits || [])
    .filter((c) => c && c.id)
    .map((c) => ({
      sha: c.id,
      shortSha: c.id.slice(0, 7),
      message: (c.message || '').split('\n')[0],
      author: c.author?.name || c.committer?.name || 'unknown',
      url: c.url || '',
      distinct: c.distinct !== false,
    }));

  return {
    deleted,
    repoFullName,
    branch,
    pusher,
    compareUrl,
    commits,
  };
}

module.exports = {
  verifySignature,
  isPushEvent,
  parsePushEvent,
};
