'use strict';
const fs = require('fs');
const path = require('path');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_RE = /^(?:[A-Za-z0-9_-]{1,64}:)?[A-Za-z0-9_-]{1,64}$/;

class Queue {
  constructor(file, { max = 2000 } = {}) {
    this.file = file;
    this.max = max;
    this.done = new Map();
    this.inflight = new Map();
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const items = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(items)) for (const [id, ack] of items.slice(-this.max)) if (KEY_RE.test(id)) this.done.set(id, ack);
    } catch {}
  }

  persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.done]), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  static validId(id) {
    return typeof id === 'string' && ID_RE.test(id);
  }

  seen(id) {
    return this.done.has(id) || this.inflight.has(id);
  }

  get(id) {
    return this.done.get(id);
  }

  record(id, ack) {
    this.done.delete(id);
    this.done.set(id, ack);
    while (this.done.size > this.max) this.done.delete(this.done.keys().next().value);
    this.persist();
  }

  async run(id, fn) {
    if (this.done.has(id)) return { ...this.done.get(id), duplicate: true };
    if (this.inflight.has(id)) return { ...(await this.inflight.get(id)), duplicate: true };
    const p = (async () => {
      let ack;
      try {
        ack = await fn();
      } catch (e) {
        ack = { ok: false, error: e.code || 'failed' };
      }
      if (!ack.retry) this.record(id, { ok: ack.ok, error: ack.error });
      return ack;
    })();
    this.inflight.set(id, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(id);
    }
  }
}

module.exports = { Queue, ID_RE };
