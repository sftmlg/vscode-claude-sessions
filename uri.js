'use strict';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseOpenUri(uri) {
  if (!uri || uri.path !== '/open') return null;
  const sessionId = new URLSearchParams(uri.query || '').get('sessionId');
  return sessionId && SESSION_ID.test(sessionId) ? sessionId.toLowerCase() : null;
}

async function handleOpen({ sessionId, findTab, focus, forward, resumeHere, info }) {
  const tab = findTab(sessionId);
  if (tab) {
    await focus(tab);
    return 'focused';
  }
  let answer = null;
  try {
    answer = await forward(sessionId);
  } catch {
    answer = null;
  }
  if (answer && answer.queued) {
    info(`Session opens in another window${answer.window ? `: ${answer.window}` : ''}.`);
    return 'forwarded';
  }
  await resumeHere(sessionId);
  return 'resumed';
}

module.exports = { parseOpenUri, handleOpen };
