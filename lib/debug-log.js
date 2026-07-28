/* eslint-disable */
// #region agent log — debug session 787efc (remove after verification)
/**
 * Debug instrumentation sink.
 *
 * Railway containers cannot reach the local debug server, so payloads are also
 * printed to stdout (visible in Railway logs) as NDJSON.
 */

const ENDPOINT = 'http://127.0.0.1:7746/ingest/9455cf0d-e16f-450f-84d6-526c2bd18e02';
const SESSION_ID = '787efc';

function agentLog(payload) {
  const entry = { sessionId: SESSION_ID, timestamp: Date.now(), ...payload };
  try {
    console.log(`[agent-log] ${JSON.stringify(entry)}`);
  } catch {}
  try {
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': SESSION_ID },
      body: JSON.stringify(entry),
    }).catch(() => {});
  } catch {}
}

module.exports = { agentLog };
// #endregion
