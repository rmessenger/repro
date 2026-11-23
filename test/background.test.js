import test from 'node:test';
import assert from 'node:assert/strict';
const listeners = {};
const event = name => ({ addListener: fn => { listeners[name] = fn; } });
const stored = {};
const focused = [], forwarded = [], starts = [], effects = [], badges = new Map();
let startError, enableError;
const titles = new Map();
const tabs = new Map([[1, { id: 1, windowId: 1, active: false, url: 'https://example.com/a' }], [2, { id: 2, windowId: 1, active: true, url: 'https://example.com/b' }]]);
globalThis.chrome = {
  runtime: {
    onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message'),
    getContexts: async () => [{}], getURL: path => `chrome-extension://test/${path}`,
    sendMessage: async message => {
      forwarded.push(message);
      switch (message.type) {
        case 'approvedStart': starts.push(message.sessionId); return startError ? { error: startError } : { recording: true };
        case 'enable': return enableError ? { error: enableError } : {};
        default: return {};
      }
    },
  },
  storage: { session: { get: async () => structuredClone(stored), set: async value => Object.assign(stored, structuredClone(value)) } },
  alarms: { create: async () => {}, onAlarm: event('alarm') },
  tabs: {
    get: async id => tabs.get(id), update: async id => { focused.push(id); },
    sendMessage: async id => ({ tabId: id }), onActivated: event('activated'), onUpdated: event('updated'), onRemoved: event('removed'),
  },
  windows: { update: async () => {}, onRemoved: event('windowRemoved') },
  action: { onClicked: event('clicked'), setBadgeText: async ({ tabId, text }) => badges.set(tabId, text), setBadgeBackgroundColor: async () => {}, setTitle: async ({ tabId, title }) => titles.set(tabId, title) },
  scripting: { executeScript: async options => {
    effects.push({ type: options.func?.name || 'inject', tabId: options.target.tabId, visible: options.args?.[1] });
    return [{ documentId: 'current-document', result: { shown: options.args?.[1] === true } }];
  } },
  tabCapture: { getMediaStreamId: async ({ targetTabId }) => { effects.push({ type: 'stream', tabId: targetTabId }); return `stream-${targetTabId}`; } },
};
await import('../extension/background.js');
function send(type, options, sender = {}) {
  return new Promise((resolve, reject) => listeners.message({ destination: 'background', type, options }, sender, response => {
    if (response.error) reject(new Error(response.error)); else resolve(response.result);
  }));
}
async function settled(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(predicate(), 'background operation completed');
}
test('two agents queue approval, retain separate routes, and release independently', async () => {
  const [a, b] = await Promise.all([
    send('requestCapture', { sessionId: 'a', tabId: 1, url: tabs.get(1).url, approval: 'toolbar' }),
    send('requestCapture', { sessionId: 'b', tabId: 2, url: tabs.get(2).url, approval: 'toolbar' }),
  ]);
  assert.equal(a.state, 'awaiting_approval'); assert.equal(b.state, 'queued');
  assert.deepEqual(focused, [1]);
  assert.equal(a.banner.shown, true);
  assert.deepEqual(effects.filter(e => e.visible === true).map(e => e.tabId), [1]);
  listeners.clicked(tabs.get(1));
  await settled(() => starts.length === 1 && focused.length === 2);
  assert.deepEqual(focused, [1, 2]);
  assert.equal(badges.get(1), 'ON'); assert.equal(badges.get(2), 'REC?');
  listeners.clicked(tabs.get(2));
  await settled(() => starts.length === 2 && badges.get(2) === 'ON');
  assert.deepEqual(starts, ['a', 'b']);
  assert.deepEqual(effects.filter(e => ['updateApprovalBanner', 'stream'].includes(e.type)), [
    { type: 'updateApprovalBanner', tabId: 1, visible: true },
    { type: 'updateApprovalBanner', tabId: 1, visible: false },
    { type: 'stream', tabId: 1 },
    { type: 'updateApprovalBanner', tabId: 2, visible: true },
    { type: 'updateApprovalBanner', tabId: 2, visible: false },
    { type: 'stream', tabId: 2 },
  ]);
  assert.deepEqual(await send('resolve', { sessionId: 'a' }), { tabId: 1, tabActive: false });
  assert.deepEqual(await send('resolve', { sessionId: 'b' }), { tabId: 2, tabActive: true });
  await new Promise(resolve => listeners.message({ destination: 'background', type: 'event', event: { type: 'click', x: 10 } }, { tab: { id: 2 } }, resolve));
  assert.equal(forwarded.at(-1).sessionId, 'b');
  await assert.rejects(send('resolve', { sessionId: 'unknown' }), /not enabled/);
  await listeners.activated();
  assert.deepEqual(forwarded.filter(m => m.type === 'tabActivity'), [
    { destination: 'offscreen', type: 'tabActivity', sessionId: 'a', active: false },
    { destination: 'offscreen', type: 'tabActivity', sessionId: 'b', active: true },
  ]);
  await listeners.updated(2, { status: 'complete' });
  assert.deepEqual(forwarded.at(-1), { destination: 'offscreen', type: 'cursorNewDocument', sessionId: 'b', documentId: 'current-document' });
  await send('released', { sessionId: 'a' });
  assert.equal(badges.get(1), ''); assert.equal(badges.get(2), 'ON');
  assert.deepEqual(await send('resolve', { sessionId: 'b' }), { tabId: 2, tabActive: true });
  assert.equal((await send('approvalStatus', { sessionId: 'b' })).state, 'recording');
});

function decline(requestId, tabId) {
  return new Promise((resolve, reject) => listeners.message({ destination: 'background', type: 'bannerDecline', requestId }, { tab: { id: tabId } }, response => {
    if (response.error) reject(new Error(response.error)); else resolve(response.result);
  }));
}
test('banner cancellation is bound to its tab and request, then advances the queue', async () => {
  await send('released', { sessionId: 'b' });
  const a = await send('requestCapture', { sessionId: 'cancel-a', tabId: 1, url: tabs.get(1).url, approval: 'toolbar' });
  await send('requestCapture', { sessionId: 'cancel-b', tabId: 2, url: tabs.get(2).url, approval: 'toolbar' });
  await assert.rejects(decline(a.requestId, 2), /no longer active/);
  await assert.rejects(decline('stale-request', 1), /no longer active/);
  assert.equal((await decline(a.requestId, 1)).state, 'declined');
  assert.equal((await send('approvalStatus', { sessionId: 'cancel-b' })).state, 'awaiting_approval');
  assert.deepEqual(effects.slice(-2), [
    { type: 'updateApprovalBanner', tabId: 1, visible: false },
    { type: 'updateApprovalBanner', tabId: 2, visible: true },
  ]);
  await send('released', { sessionId: 'cancel-a' });
  await send('released', { sessionId: 'cancel-b' });
});
test('expiry and navigation remove pending banners and reload restores a current request', async () => {
  await send('requestCapture', { sessionId: 'expire', tabId: 1, url: tabs.get(1).url, approval: 'toolbar' });
  stored.captureRequests.find(r => r.sessionId === 'expire').expiresAt = Date.now() - 1;
  await listeners.alarm({ name: 'approval-expiry' });
  assert.equal((await send('approvalStatus', { sessionId: 'expire' })).state, 'expired');
  assert.deepEqual(effects.at(-1), { type: 'updateApprovalBanner', tabId: 1, visible: false });
  await send('released', { sessionId: 'expire' });
  await send('requestCapture', { sessionId: 'navigate', tabId: 1, url: tabs.get(1).url, approval: 'toolbar' });
  await listeners.updated(1, { status: 'complete' });
  assert.deepEqual(effects.at(-1), { type: 'updateApprovalBanner', tabId: 1, visible: true });
  await listeners.updated(1, { url: 'https://example.com/changed' });
  assert.equal((await send('approvalStatus', { sessionId: 'navigate' })).state, 'failed');
  assert.deepEqual(effects.at(-1), { type: 'updateApprovalBanner', tabId: 1, visible: false });
  await send('released', { sessionId: 'navigate' });
});

test('a failed first crop keeps the approved tab ON and recovery clears the stale error', async t => {
  t.after(() => { startError = undefined; });
  startError = 'Target did not match any visible element.';
  await send('requestCapture', { sessionId: 'bad-crop', tabId: 1, url: tabs.get(1).url, approval: 'toolbar' });
  await send('requestCapture', { sessionId: 'next-tab', tabId: 2, url: tabs.get(2).url, approval: 'toolbar' });
  await assert.rejects(listeners.clicked(tabs.get(1)), /Target did not match/);
  assert.equal(badges.get(1), 'ON');
  assert.equal(badges.get(2), 'REC?');
  assert.equal((await send('approvalStatus', { sessionId: 'bad-crop' })).error, startError);
  assert.deepEqual(await send('resolve', { sessionId: 'bad-crop' }), { tabId: 1, tabActive: false });
  // Also repairs ERR badges left by an older extension version.
  badges.set(1, 'ERR');
  await send('captureReady', { sessionId: 'bad-crop', recording: true });
  assert.equal(badges.get(1), 'ON');
  assert.equal(titles.get(1), 'Evidence capture enabled for this tab');
  assert.equal((await send('approvalStatus', { sessionId: 'bad-crop' })).error, undefined);
  assert.equal((await send('approvalStatus', { sessionId: 'bad-crop' })).state, 'recording');
  assert.equal(badges.get(2), 'REC?');
  await send('released', { sessionId: 'bad-crop' });
  await send('released', { sessionId: 'next-tab' });
});
test('a capture permission failure still shows ERR until a new approval succeeds', async t => {
  t.after(() => { enableError = undefined; });
  enableError = 'Tab capture permission was denied.';
  await send('requestCapture', { sessionId: 'blocked', tabId: 1, url: tabs.get(1).url, approval: 'toolbar' });
  await assert.rejects(listeners.clicked(tabs.get(1)), /permission was denied/);
  assert.equal(badges.get(1), 'ERR');
  await assert.rejects(send('captureReady', { sessionId: 'blocked', recording: true }), /not enabled/);
  assert.equal(badges.get(1), 'ERR');
  enableError = undefined;
  await send('requestCapture', { sessionId: 'blocked', tabId: 1, url: tabs.get(1).url, approval: 'toolbar' });
  await listeners.clicked(tabs.get(1));
  assert.equal(badges.get(1), 'ON');
  assert.equal((await send('approvalStatus', { sessionId: 'blocked' })).error, undefined);
  await send('released', { sessionId: 'blocked' });
});
