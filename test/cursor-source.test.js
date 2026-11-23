import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCursorSource } from '../src/cursor-source.js';
import { planCursor, planCursorHolds } from '../src/cursor.js';
import { planPlayback } from '../src/playback.js';
const sample = (t, x, type = 'pointerdown', tabActive = true) => ({ t, x, y: 100, type, buttons: 0, tabActive });
const point = (t, x, opacity = 1) => ({ at: 1000 + t * 1000, x, y: 100, opacity });
const fixture = (samples, points, events = []) => ({ animateCursor: true, captureStartedAt: 1000, duration: 8, cursorSuppression: { safeForAnimation: true, tracking: { valid: true, points } }, pointerSamples: samples, events, geometry: { tabActive: true, region: { x: 0, y: 0, width: 800, height: 400 } } });
test('foreground physical movement and clicks cannot pull the cursor away from overlay targets', () => {
  const result = selectCursorSource(fixture([sample(1, 100), sample(2, 700, 'pointermove'), sample(2.1, 700), sample(3, 300)], [point(0.99, 100), point(2.99, 300)]));
  assert.deepEqual(result.pointerSamples.map(p => p.x), [100, 300]);
  assert.equal(result.cursorSource.ignoredSamples, 2);
});
test('background events survive a stale overlay and foreground return rejects the old position', () => {
  const result = selectCursorSource(fixture([sample(1, 100), sample(3, 400, 'pointerdown', false), sample(4, 500, 'pointermove', false), sample(5.1, 100), sample(6, 600)], [point(1, 100), point(2, 100, 0), point(6, 600)], [{ type: 'tabActivity', t: 2, active: false }, { type: 'tabActivity', t: 5, active: true }]));
  assert.deepEqual(result.pointerSamples.map(p => p.x), [100, 400, 500, 600]);
  assert.equal(result.cursorSource.backgroundSamples, 2);
  assert.equal(result.cursorSource.foregroundSamples, 2);
});
test('small delivery skew, repeated clicks and releases retain exact page event timing', () => {
  const samples = [sample(1, 100, 'pointermove'), sample(1.01, 100), sample(1.02, 100, 'pointerup'), sample(2, 100)];
  const result = selectCursorSource(fixture(samples, [point(1.04, 100)]));
  assert.deepEqual(result.pointerSamples.map(p => p.t), samples.map(p => p.t));
});
test('unverified tracking disables animation instead of falling back to mixed foreground events', () => {
  const data = fixture([sample(1, 100)], []);
  data.cursorSuppression.tracking.valid = false;
  const result = selectCursorSource(data);
  assert.equal(result.cursorSuppression.safeForAnimation, false);
  assert.match(result.warnings[0], /could not be verified/);
});
test('legacy captures remain exportable without inferred source attribution', () => {
  const data = { animateCursor: true, pointerSamples: [sample(1, 100)] };
  assert.equal(selectCursorSource(data), data);
});
test('filtered actions still receive smooth travel holds and retain rapid click order', () => {
  const result = selectCursorSource(fixture([sample(1, 100), sample(1.01, 700), sample(1.02, 300)], [point(0.999, 100), point(1.009, 700), point(1.019, 300)]));
  const timeline = [{ start: 0, end: 4 }];
  const holds = planCursorHolds(result, planPlayback(timeline, [], 4)).holds;
  const plan = planCursor(result, planPlayback(timeline, [], 4, [], holds), result.geometry, { width: 800, height: 400 }, holds);
  assert.deepEqual(plan.clicks.map(p => p.x), [100, 700, 300]);
  assert.ok(plan.clicks[1].t - plan.clicks[0].t > 0.3);
});

test('unchanged activity from another window does not invalidate a stationary agent cursor', () => {
  const result = selectCursorSource(fixture([sample(1, 100), sample(3, 100), sample(4, 300)], [point(1, 100), point(4, 300)], [{ type: 'tabActivity', t: 2, active: true }]));
  assert.deepEqual(result.pointerSamples.map(p => p.t), [1, 3, 4]);
  assert.equal(result.cursorSource.ignoredSamples, 0);
});

test('a background tab keeps recorded clicks through a reload with no final overlay report', () => {
  const data = fixture([sample(1, 100, 'pointerdown', false), sample(4, 400, 'pointerdown', false)], []);
  data.geometry.tabActive = false;
  data.cursorSuppression = { requested: false, safeForAnimation: false };
  data.cursorCoverage = { source: 'tab', knownOverlay: true, spans: [] };
  const result = selectCursorSource(data);
  assert.deepEqual(result.pointerSamples.map(p => p.x), [100, 400]);
  assert.deepEqual(result.cursorWindows, [{ start: 0, end: 8 }]);
  assert.equal(result.cursorSource.backgroundSamples, 2);
});

test('background fallback does not assume other harnesses hide their cursor', () => {
  const data = fixture([sample(3, 100, 'pointerdown', false)], []);
  data.geometry.tabActive = false;
  data.cursorCoverage = { source: 'tab', knownOverlay: false, spans: [] };
  const result = selectCursorSource(data);
  assert.equal(result.pointerSamples.length, 0);
  assert.equal(result.cursorRingOnly.length, 1);
});
