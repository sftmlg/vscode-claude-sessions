'use strict';

const PUSH_DEBOUNCE_MS = 2000;
const PUSH_EVERY_MS = 60000;
const POLL_MS = 2000;
const MAX_BACKOFF_MS = 30000;
const REQUEST_TIMEOUT_MS = 5000;
const WATCHDOG_MS = 60000;
const DEFAULT_TIMEOUT_MS = 30000;
const COMMAND_TIMEOUTS_MS = { newSession: 120000, openSession: 120000, sendText: 20000 };
const PARALLEL_TYPES = new Set(['checkUpdate']);

function createHub({ url, enabled, buildState, execute, repo, log = () => {}, fetchImpl = globalThis.fetch, pollMs = POLL_MS, debounceMs = PUSH_DEBOUNCE_MS, onProgress = () => {}, watchdogMs = WATCHDOG_MS, timeouts = {} }) {
  let pollStartedAt = 0;
  let serial = Promise.resolve();
  const inflight = new Set();
  const limits = { ...COMMAND_TIMEOUTS_MS, ...timeouts };
  let timers = [];
  let debounce = null;
  let stopped = true;
  let backoff = pollMs;
  let downUntil = 0;
  let pushing = null;
  let pushAgain = false;
  let polling = null;

  const base = () => String(url() || '').replace(/\/+$/, '');
  const live = () => !stopped && enabled() && Boolean(base());

  async function call(method, path, body) {
    const res = await fetchImpl(`${base()}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  function reached() {
    backoff = pollMs;
    downUntil = 0;
  }

  function unreachable(err) {
    if (!downUntil) log(`hub unreachable: ${err.message}`);
    downUntil = Date.now() + backoff;
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
  }

  async function pushNow() {
    if (!live() || Date.now() < downUntil) return;
    if (pushing) {
      pushAgain = true;
      return pushing;
    }
    pushing = (async () => {
      try {
        do {
          pushAgain = false;
          await call('PUT', '/api/plugin/state', await buildState());
          reached();
        } while (pushAgain);
      } catch (err) {
        unreachable(err);
      } finally {
        pushing = null;
      }
    })();
    return pushing;
  }

  function requestPush() {
    if (!live() || debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      pushNow();
    }, debounceMs);
  }

  function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async function runCommand(cmd) {
    let result;
    onProgress(cmd, 'opening');
    await pushNow();
    try {
      const out = await withTimeout(Promise.resolve().then(() => execute(cmd)), limits[cmd.type] || limits.default || DEFAULT_TIMEOUT_MS);
      result = { ok: true };
      if (out && typeof out.note === 'string') result.note = out.note;
      if (out && typeof out.delivered === 'boolean') result.delivered = out.delivered;
      if (out && (typeof out.sessionId === 'string' || out.sessionId === null)) result.sessionId = out.sessionId;
      if (out && 'installed' in out) result.installed = out.installed;
      if (out && typeof out.current === 'string') result.current = out.current;
      if (out && typeof out.started === 'boolean') result.started = out.started;
      onProgress(cmd, 'ready', result);
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : String(err) };
      if (result.error === 'timeout') log(`hub: command ${cmd.id} (${cmd.type}) timed out`);
      onProgress(cmd, 'error', result);
    }
    try {
      await call('POST', `/api/plugin/commands/${encodeURIComponent(cmd.id)}/result`, result);
    } catch (err) {
      log(`hub: result for ${cmd.id} not delivered: ${err.message}`);
    }
    await pushNow();
  }

  function dispatch(cmd) {
    let task;
    if (PARALLEL_TYPES.has(cmd.type)) {
      task = runCommand(cmd);
    } else {
      task = serial.then(() => runCommand(cmd));
      serial = task.catch(() => undefined);
    }
    const tracked = task.catch((err) => log(`hub: command ${cmd.id} failed: ${err.message}`)).finally(() => inflight.delete(tracked));
    inflight.add(tracked);
  }

  async function takeCommands() {
    if (!live() || Date.now() < downUntil) return;
    try {
      const commands = await call('POST', `/api/plugin/commands/take?repo=${encodeURIComponent(repo)}`);
      reached();
      const batch = Array.isArray(commands) ? commands : [];
      for (const cmd of batch) onProgress(cmd, 'queued');
      for (const cmd of batch) dispatch(cmd);
    } catch (err) {
      unreachable(err);
    }
  }

  function pollOnce() {
    if (polling && Date.now() - pollStartedAt > watchdogMs) {
      log(`hub: poll round stuck for ${Math.round((Date.now() - pollStartedAt) / 1000)} s, restarting the loop`);
      polling = null;
    }
    if (!polling) {
      pollStartedAt = Date.now();
      const round = takeCommands().finally(() => {
        if (polling === round) polling = null;
      });
      polling = round;
    }
    return polling;
  }

  async function drain() {
    await polling;
    await pollOnce();
    while (inflight.size) await Promise.all([...inflight]);
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    pushNow();
    pollOnce();
    timers = [setInterval(pollOnce, pollMs), setInterval(pushNow, PUSH_EVERY_MS)];
  }

  function stop() {
    stopped = true;
    clearTimeout(debounce);
    debounce = null;
    for (const t of timers) clearInterval(t);
    timers = [];
  }

  async function forwardOpen(sessionId) {
    if (!live()) return null;
    return call('POST', `/api/plugin/open-forward?repo=${encodeURIComponent(repo)}`, { sessionId });
  }

  return { start, stop, requestPush, pushNow, pollOnce, drain, forwardOpen };
}

module.exports = { createHub };
