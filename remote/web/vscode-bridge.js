(function () {
  'use strict';
  if (typeof acquireVsCodeApi !== 'function') return;
  const vscode = acquireVsCodeApi();
  const pending = new Map();
  let seq = 0;

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (!m || m.t !== 'reply' || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(String(m.error)));
    else resolve(m.value);
  });

  function request(t, fields) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      vscode.postMessage({ t, id, ...fields });
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error('no answer from the editor'));
      }, 15000);
    });
  }

  window.claudeRemoteHost = {
    wsUrl: document.documentElement.getAttribute('data-ws-url') || '',
    getToken: () => request('getToken', {}),
    setToken: (token) => request('setToken', { token: token == null ? null : String(token) }),
  };
})();
