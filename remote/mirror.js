'use strict';
const { EventEmitter } = require('events');
const { ControlClient, replayBytes } = require('./tmux');

const HIGH_WATER = 64 * 1024;
const LOW_WATER = 16 * 1024;
const MIN_DELAY = 40;
const MAX_DELAY = 250;
const FORCE_FLUSH_BYTES = 256 * 1024;
const CLAIM_TIMEOUT_MS = 60000;
const MIN_COLS = 20;
const MAX_COLS = 400;
const MIN_ROWS = 5;
const MAX_ROWS = 200;

function frame(name, seq, bytes) {
  const nameBuf = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(1 + 2 + nameBuf.length + 4);
  head[0] = 1;
  head.writeUInt16BE(nameBuf.length, 1);
  nameBuf.copy(head, 3);
  head.writeUInt32BE(seq >>> 0, 3 + nameBuf.length);
  return Buffer.concat([head, bytes]);
}

function parseFrame(buf) {
  if (buf[0] !== 1) return null;
  const len = buf.readUInt16BE(1);
  return { sessionId: buf.subarray(3, 3 + len).toString('utf8'), seq: buf.readUInt32BE(3 + len), bytes: buf.subarray(7 + len) };
}

const adaptiveDelay = (bytes) => Math.max(MIN_DELAY, Math.min(MAX_DELAY, Math.round(bytes / 64)));

class Mirror extends EventEmitter {
  constructor(ctx, name, { claimTimeoutMs = CLAIM_TIMEOUT_MS, ControlClientClass = ControlClient } = {}) {
    super();
    this.ctx = ctx;
    this.name = name;
    this.claimTimeoutMs = claimTimeoutMs;
    this.ControlClientClass = ControlClientClass;
    this.viewers = new Map();
    this.seq = 0;
    this.pending = [];
    this.pendingBytes = 0;
    this.timer = null;
    this.delay = MIN_DELAY;
    this.paneId = null;
    this.cols = 0;
    this.rows = 0;
    this.claimState = null;
    this.sizer = null;
    this.closed = false;
  }

  start() {
    this.cc = new this.ControlClientClass(this.ctx, this.name).start();
    this.cc.on('output', (paneId, bytes) => this.onOutput(paneId, bytes));
    this.cc.on('notification', (kind) => {
      if (kind === '%layout-change') this.scheduleResnapshot();
    });
    this.cc.on('exit', () => this.end());
    this.watch = setInterval(() => this.tick(), 100);
    this.watch.unref();
    return this;
  }

  onOutput(paneId, bytes) {
    if (this.paneId && paneId !== this.paneId) return;
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    if (this.pendingBytes >= FORCE_FLUSH_BYTES) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.delay);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.length) return;
    const data = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    this.delay = adaptiveDelay(data.length);
    this.seq = (this.seq + 1) >>> 0;
    const out = frame(this.name, this.seq, data);
    for (const entry of this.viewers.values()) {
      if (!entry.ready || entry.paused) continue;
      if (entry.viewer.bufferedAmount() > HIGH_WATER) {
        entry.paused = true;
        continue;
      }
      entry.viewer.sendBinary(out);
    }
  }

  tick() {
    for (const entry of this.viewers.values()) {
      if (entry.paused && !entry.snapshotting && entry.viewer.bufferedAmount() < LOW_WATER) this.snapshotFor([entry]);
    }
    if (this.claimState && Date.now() - this.claimState.lastSeen > this.claimTimeoutMs) this.release(this.claimState.viewerId);
  }

  addViewer(viewer) {
    const entry = { viewer, ready: false, paused: false, snapshotting: false };
    this.viewers.set(viewer.id, entry);
    if (this.claimState) viewer.sendJson(this.sizeMessage());
    return this.snapshotFor([entry]);
  }

  removeViewer(id) {
    if (!this.viewers.delete(id)) return;
    if (this.claimState && this.claimState.viewerId === id) this.release(id);
    if (!this.viewers.size) this.close();
  }

  touch(id) {
    if (this.claimState && this.claimState.viewerId === id) this.claimState.lastSeen = Date.now();
  }

  scheduleResnapshot() {
    clearTimeout(this.resnapTimer);
    this.resnapTimer = setTimeout(() => this.snapshotFor([...this.viewers.values()]), 100);
  }

  async snapshotFor(entries) {
    if (this.closed || !entries.length) return;
    for (const e of entries) {
      e.ready = false;
      e.snapshotting = true;
    }
    let snap;
    try {
      snap = await this.cc.snapshot({ onBegin: () => this.flush() });
    } catch (err) {
      for (const e of entries) e.snapshotting = false;
      if (!this.closed) this.emit('error', err);
      return;
    }
    this.paneId = snap.paneId;
    this.cols = snap.cols;
    this.rows = snap.rows;
    const body = frame(this.name, this.seq, replayBytes(snap));
    const msg = { t: 'snapshot', sessionId: this.name, seq: this.seq, cols: snap.cols, rows: snap.rows, cursor: snap.cursor, alt: snap.alt };
    for (const e of entries) {
      e.snapshotting = false;
      if (this.viewers.get(e.viewer.id) !== e) continue;
      e.paused = false;
      e.ready = true;
      e.viewer.sendJson(msg);
      e.viewer.sendBinary(body);
    }
  }

  sizeMessage() {
    const c = this.claimState;
    return { t: 'size', sessionId: this.name, cols: c ? c.cols : this.cols, rows: c ? c.rows : this.rows, claimedBy: c ? c.label : null };
  }

  broadcast(msg) {
    for (const e of this.viewers.values()) e.viewer.sendJson(msg);
  }

  async claim(viewerId, label, cols, rows) {
    if (!this.viewers.has(viewerId)) throw new Error('not subscribed');
    cols = Math.floor(Number(cols));
    rows = Math.floor(Number(rows));
    if (!(cols >= MIN_COLS && cols <= MAX_COLS && rows >= MIN_ROWS && rows <= MAX_ROWS)) throw new Error('size out of range');
    const previous = this.claimState ? this.claimState.previous : await this.windowSize();
    if (this.closed || !this.viewers.has(viewerId)) throw new Error('not subscribed');
    this.claimState = { viewerId, label, cols, rows, previous, lastSeen: Date.now() };
    if (!this.sizer || this.sizer.closed) {
      this.sizer = new this.ControlClientClass(this.ctx, this.name).start();
      this.sizer.on('exit', () => {
        if (this.sizer && this.sizer.closed) this.sizer = null;
      });
    }
    await this.sizer.setSize(cols, rows);
    this.broadcast(this.sizeMessage());
  }

  async windowSize() {
    const [lines] = await this.cc.command(`display -p -t =${this.name}: '#{window_width}x#{window_height}'`);
    const [cols, rows] = String(lines[0] || '').split('x').map(Number);
    return cols && rows ? { cols, rows } : { cols: this.cols, rows: this.rows };
  }

  async release(viewerId) {
    const c = this.claimState;
    if (!c || c.viewerId !== viewerId) return;
    this.claimState = null;
    const sizer = this.sizer;
    this.sizer = null;
    if (sizer && !sizer.closed) {
      try {
        if (c.previous.cols && c.previous.rows) await sizer.setSize(c.previous.cols, c.previous.rows);
      } catch {}
      sizer.close();
    }
    if (!this.closed) this.broadcast(this.sizeMessage());
  }

  end() {
    if (this.closed) return;
    this.broadcast({ t: 'error', code: 'session-ended', msg: `Session ${this.name} ended`, sessionId: this.name });
    this.close();
  }

  close() {
    if (this.closed) return;
    const claim = this.claimState;
    if (claim) this.release(claim.viewerId);
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.resnapTimer);
    clearInterval(this.watch);
    if (this.cc) this.cc.close();
    this.viewers.clear();
    this.emit('closed');
  }
}

module.exports = { Mirror, frame, parseFrame, adaptiveDelay, HIGH_WATER, LOW_WATER };
