'use strict';
const fs = require('fs');
const path = require('path');

const DEVICE_RE = /^dev-[0-9a-f]{12}$/;

class SeenStore {
  constructor(stateDir, { flushMs = 2000 } = {}) {
    this.dir = path.join(stateDir, 'seen');
    this.flushMs = flushMs;
    this.devices = new Map();
    this.dirty = new Set();
    this.timer = null;
  }

  device(deviceId) {
    if (!DEVICE_RE.test(String(deviceId))) throw new Error('invalid device id');
    let map = this.devices.get(deviceId);
    if (!map) {
      map = new Map();
      try {
        for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(this.dir, `${deviceId}.json`), 'utf8')))) if (Number.isFinite(v)) map.set(k, v);
      } catch {}
      this.devices.set(deviceId, map);
    }
    return map;
  }

  unread(deviceId, item) {
    if (!item || !item.sessionId || !Number.isFinite(item.transcriptSize)) return false;
    const map = this.device(deviceId);
    if (!map.has(item.sessionId)) {
      map.set(item.sessionId, item.transcriptSize);
      this.touch(deviceId);
      return false;
    }
    return item.transcriptSize > map.get(item.sessionId);
  }

  mark(deviceId, item) {
    const map = this.device(deviceId);
    if (!item || !item.sessionId || !Number.isFinite(item.transcriptSize)) return;
    map.set(item.sessionId, item.transcriptSize);
    this.touch(deviceId);
  }

  touch(deviceId) {
    this.dirty.add(deviceId);
    if (this.flushMs === 0) return;
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
      this.timer.unref();
    }
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty.size) return;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const deviceId of this.dirty) {
      const file = path.join(this.dir, `${deviceId}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.devices.get(deviceId))), { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
    this.dirty.clear();
  }
}

module.exports = { SeenStore };
