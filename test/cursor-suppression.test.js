import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../extension/cursor-suppression.js', import.meta.url), 'utf8');
function fixture({ supported = true, blockedStyle = false } = {}) {
  const document = new EventTarget();
  const observers = [], messages = [], pageListeners = {};
  let mounted = supported;
  const cursor = () => ({ style: { opacity: '1', transform: 'translate3d(100px, 200px, 0px)' }, getBoundingClientRect: () => ({ x: 100, y: 200, width: 24, height: 24 }) });
  const host = cursor();
  const makeRoot = () => ({
    cursors: [cursor()], styles: [],
    querySelectorAll() { return this.cursors; },
    append(style) { style.parentNode = this; this.styles.push(style); },
  });
  let root = makeRoot();
  const original = root;
  document.documentElement = {};
  document.visibilityState = 'visible';
  document.getElementById = () => mounted ? host : null;
  document.createElement = () => ({ textContent: '', parentNode: null, remove() { this.parentNode.styles.splice(this.parentNode.styles.indexOf(this), 1); this.parentNode = null; } });
  const context = vm.createContext({ document, Date, Map, JSON, Boolean, addEventListener(type, callback) { pageListeners[type] = callback; }, setInterval: () => 1, clearInterval() {}, chrome: { dom: { openOrClosedShadowRoot: () => root }, runtime: { id: 'test-extension', sendMessage: async message => { messages.push(message); }, onMessage: { addListener() {} } } }, MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } }, getComputedStyle: element => ({ display: !blockedStyle && root.styles.length ? 'none' : 'block', transform: element.style.transform, opacity: element.style.opacity, width: '24px', height: '24px', left: '0px', top: '0px' }) });
  vm.runInContext(source, context);
  return { context, messages, pageListeners, mount: () => { mounted = true; }, control: context.__reproCursorSuppression, document, original, observers, get root() { return root; }, replaceRoot: () => { root = makeRoot(); }, replaceCursor: () => { root.cursors = [cursor()]; } };
}
test('extension suppresses only the recognized cursor and restores its stylesheet on stop', () => {
  const page = fixture();
  assert.equal(page.control.start().safeForAnimation, true);
  assert.equal(page.root.styles.length, 1);
  assert.equal(page.root.styles[0].textContent, '[data-testid="browser-agent-cursor"]{display:none!important}');
  assert.equal(page.root.cursors[0].style.opacity, '1');
  assert.equal(page.control.stop().safeForAnimation, true);
  assert.equal(page.root.styles.length, 0);
  assert.ok(page.observers.every(observer => observer.disconnected));
});
test('unknown harnesses and failed suppression fail closed without broad hiding', () => {
  const unsupported = fixture({ supported: false });
  assert.equal(unsupported.control.start().safeForAnimation, false);
  assert.equal(unsupported.root.styles.length, 0);
  const blocked = fixture({ blockedStyle: true });
  assert.equal(blocked.control.start().safeForAnimation, false);
  blocked.control.stop();
  assert.equal(blocked.root.styles.length, 0);
});
test('cursor replacement and foreground/background transitions retain suppression', () => {
  const page = fixture();
  page.control.start();
  page.document.visibilityState = 'hidden';
  page.document.dispatchEvent(new Event('visibilitychange'));
  page.replaceCursor();
  page.observers[0].callback();
  page.document.visibilityState = 'visible';
  page.document.dispatchEvent(new Event('visibilitychange'));
  const result = page.control.stop();
  assert.equal(result.safeForAnimation, true);
  assert.ok(result.observations.some(item => item.visibility === 'hidden' && item.hidden));
  assert.ok(result.observations.some(item => item.reason === 'visibility-change' && item.visibility === 'visible' && item.hidden));
});
test('a replaced host receives a new rule and both roots are restored', () => {
  const page = fixture();
  page.control.start();
  page.replaceRoot();
  page.observers[1].callback();
  assert.equal(page.control.report().rootCount, 2);
  assert.equal(page.control.stop().safeForAnimation, true);
  assert.equal(page.original.styles.length, 0);
  assert.equal(page.root.styles.length, 0);
});
test('loss of the cursor target disqualifies the entire clip even when it returns', () => {
  const page = fixture();
  page.control.start();
  page.root.cursors = [];
  page.observers[0].callback();
  page.replaceCursor();
  page.observers[0].callback();
  const result = page.control.stop();
  assert.equal(result.verified, true);
  assert.equal(result.lost, true);
  assert.equal(result.safeForAnimation, false);
});

test('extension invalidation removes suppression instead of leaving the cursor hidden', () => {
  const page = fixture();
  page.control.start();
  page.context.chrome.runtime.id = undefined;
  page.observers[0].callback();
  assert.equal(page.root.styles.length, 0);
  assert.equal(page.control.report().safeForAnimation, false);
});

test('position probe records overlay transforms while suppression is active and deduplicates idle samples', () => {
  const page = fixture();
  const start = page.control.start(true);
  assert.equal(start.initialLayout[0].ancestors[0].inlineTransform, 'translate3d(100px, 200px, 0px)');
  assert.equal(start.poses.length, 1);
  page.observers[0].callback();
  assert.equal(page.control.report().poses.length, 1);
  page.root.cursors[0].style.transform = 'translate3d(300px, 400px, 0px)';
  page.observers[0].callback();
  page.document.visibilityState = 'hidden';
  page.document.dispatchEvent(new Event('visibilitychange'));
  page.root.cursors[0].style.transform = 'translate3d(500px, 600px, 0px)';
  page.observers[0].callback();
  const result = page.control.stop();
  assert.equal(result.poses.length, 4);
  assert.equal(result.poses[1].cursors[0].inlineTransform, 'translate3d(300px, 400px, 0px)');
  assert.equal(result.poses[3].cursors[0].transform, 'translate3d(500px, 600px, 0px)');
  assert.equal(result.poses[3].visibility, 'hidden');
  assert.equal(result.safeForAnimation, true);
  assert.equal(result.posesTruncated, false);
  assert.equal(page.root.styles.length, 0);
});
test('normal recording does not collect diagnostic geometry', () => {
  const page = fixture();
  page.root.cursors[0].getBoundingClientRect = () => { throw new Error('Unexpected geometry read'); };
  assert.equal(page.control.start().poses, undefined);
  assert.equal(page.control.stop().initialLayout, undefined);
});
test('position probe bounds retained samples and reports truncation', () => {
  const page = fixture();
  page.control.start(true);
  for (let index = 0; index < 20001; index++) {
    page.root.cursors[0].style.transform = `translateX(${index}px)`;
    page.observers[0].callback();
  }
  const result = page.control.stop();
  assert.equal(result.poses.length, 20000);
  assert.equal(result.posesTruncated, true);
});

test('normal cursor tracking records input coordinates without diagnostic geometry reads', () => {
  const page = fixture();
  page.root.cursors[0].getBoundingClientRect = () => { throw new Error('Unexpected geometry read'); };
  const start = page.control.start(false, true);
  assert.equal(start.tracking.valid, true);
  assert.equal(start.tracking.points[0].x, 112);
  assert.equal(start.tracking.points[0].y, 212);
  page.root.cursors[0].style.transform = 'translate3d(300px, 400px, 0px) rotate(316deg)';
  page.observers[0].callback();
  const result = page.control.stop();
  assert.equal(result.tracking.points.length, 2);
  assert.equal(result.tracking.points[1].x, 312);
  assert.equal(result.poses, undefined);
});
test('unitless depth with a CSS variable in the transform tracks the Codex cursor', () => {
  const page = fixture();
  page.root.cursors[0].style.transform = 'translate3d(440.734px, 498.398px, 0) rotate(316deg) scale(1, 1) scale(var(--browser-agent-cursor-scale, 1))';
  const report = page.control.start(false, true);
  assert.equal(report.safeForAnimation, true);
  assert.equal(report.tracking.valid, true);
  assert.equal(report.tracking.points[0].x, 452.734);
  assert.equal(report.tracking.points[0].y, 510.398);
  page.control.stop();
});
test('an unreadable cursor position at start leaves the original cursor visible', () => {
  const page = fixture();
  page.root.cursors[0].style.transform = 'translate3d(100px, 200px, 1px)';
  page.root.append = () => assert.fail('Suppression must only be installed after verifying cursor positions');
  const start = page.control.start(false, true);
  assert.equal(start.verified, false);
  assert.equal(start.safeForAnimation, false);
  assert.equal(start.tracking.valid, false);
  const result = page.control.stop();
  assert.equal(result.safeForAnimation, false);
  assert.equal(result.tracking.valid, false);
});
test('an unreadable position during recording restores the original cursor for the rest of the clip', () => {
  const page = fixture();
  page.control.start(false, true);
  page.root.cursors[0].style.transform = 'matrix(1, 0, 0, 1, 10, 20)';
  page.observers[0].callback();
  assert.equal(page.root.styles.length, 0);
  assert.ok(page.observers.every(observer => observer.disconnected));
  page.root.cursors[0].style.transform = 'translate3d(300px, 400px, 0px)';
  page.observers[0].callback();
  const result = page.control.stop();
  assert.equal(result.safeForAnimation, false);
  assert.equal(result.tracking.valid, false);
});


test('capture streams cursor proof before pagehide and flushes the final samples', () => {
  const page = fixture();
  assert.equal(page.control.start(false, true, 'active-clip').safeForAnimation, true);
  page.root.cursors[0].style.transform = 'translate3d(300px, 400px, 0)';
  page.observers[0].callback();
  page.pageListeners.pagehide();
  assert.deepEqual(page.messages.map(message => message.chunk.captureId), ['active-clip', 'active-clip']);
  assert.equal(page.messages[0].chunk.points[0].x, 112);
  assert.equal(page.messages[1].chunk.points[0].x, 312);
  assert.equal(page.messages[0].chunk.from, page.messages[1].chunk.from);
  assert.equal(page.root.styles.length, 0);
});

test('tracking restarted on the new document can verify an overlay that loads late', () => {
  const page = fixture({ supported: false });
  assert.equal(page.control.start(false, true, 'active-clip').safeForAnimation, false);
  page.mount();
  page.observers[0].callback();
  assert.equal(page.control.report().safeForAnimation, true);
  assert.equal(page.messages[0].chunk.points[0].x, 112);
  assert.equal(page.control.start(false, true, 'active-clip').from, page.messages[0].chunk.from);
  assert.equal(page.messages.length, 1);
  page.control.stop();
});
