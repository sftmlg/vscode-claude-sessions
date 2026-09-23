'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tabPresentation } = require('../sessions');

test('the icon always shows the session state, never focus', () => {
  assert.strictEqual(tabPresentation({ status: 'busy', focused: true }).icon, 'loading~spin');
  assert.strictEqual(tabPresentation({ status: 'idle', focused: true }).icon, 'pass-filled');
  assert.strictEqual(tabPresentation({ status: 'waiting', focused: false }).icon, 'bell-dot');
  assert.strictEqual(tabPresentation({ status: 'exited', focused: false }).icon, 'circle-slash');
  assert.strictEqual(tabPresentation({ status: undefined, focused: false }).icon, 'terminal');
});

test('focus is a dot after the name and nothing else', () => {
  assert.strictEqual(tabPresentation({ status: 'idle', focused: true }).nameSuffix, ' ●');
  assert.strictEqual(tabPresentation({ status: 'idle', focused: false }).nameSuffix, '');
});

test('the hover explains the icon and the dot', () => {
  const p = tabPresentation({ status: 'busy', focused: true });
  assert.match(p.hoverLine, /^⟳ Working/);
  assert.match(p.hoverLine, /● This tab is selected/);
  assert.match(tabPresentation({ status: 'idle', focused: false }).hoverLine, /^✓ Idle/);
  assert.doesNotMatch(tabPresentation({ status: 'idle', focused: false }).hoverLine, /selected/);
});
