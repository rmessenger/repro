import test from 'node:test';
import assert from 'node:assert/strict';
import { planTimeline, visualChange } from '../src/timeline.js';
import { schemas } from '../src/schema.js';
test('idle gaps are removed while preserving interaction context and an omission record', () => {
  const timeline = planTimeline(20, [], [{ t: 2, type: 'pointerdown' }, { t: 17, type: 'pointerdown' }]);
  assert.deepEqual(timeline.map(segment => Object.fromEntries(Object.entries(segment).map(([key, value]) => [key, Number(value.toFixed(3))]))), [{ start: 0, end: 2.7, omittedBefore: 0 }, { start: 16.4, end: 17.7, omittedBefore: 13.7 }, { start: 19.4, end: 20, omittedBefore: 1.7 }]);
});
test('preserveTiming retains real application delays', () => {
  assert.deepEqual(planTimeline(20, [], [], true), [{ start: 0, end: 20, omittedBefore: 0 }]);
});
test('visual changes retain activity without input', () => {
  const samples = Array.from({ length: 40 }, (_, i) => ({ t: i / 2, changed: true }));
  assert.deepEqual(planTimeline(20, samples, []), [{ start: 0, end: 20, omittedBefore: 0 }]);
});
test('tiny changes such as a caret do not prevent idle trimming', () => {
  const first = new Uint8ClampedArray(160 * 100 * 4);
  const second = first.slice(); second.fill(255, 0, 20 * 4);
  assert.equal(visualChange(first, second), false);
  second.fill(255, 0, 100 * 4);
  assert.equal(visualChange(first, second), true);
});
test('screenshot regions accept unions while recording uses automatic framing', () => {
  assert.equal(schemas.screenshot.parse({ sessionId: crypto.randomUUID(), region: [{ testId: 'dialog' }, { role: 'button', name: 'Save' }] }).padding, 24);
  assert.equal(schemas.start.parse({}).framing, 'auto');
  assert.throws(() => schemas.start.parse({ region: { x: 0, y: 0, width: 100, height: 50 } }));
  assert.throws(() => schemas.start.parse({ padding: 24 }));
  assert.throws(() => schemas.start.parse({ maxSeconds: 900 }));
});

test('sub-second idle trimming removes a 0.9-second gap but retains a 0.7-second gap', () => {
  const cut = planTimeline(10, [], [{ t: 2, type: 'click' }, { t: 4.2, type: 'click' }]);
  const kept = planTimeline(10, [], [{ t: 2, type: 'click' }, { t: 4, type: 'click' }]);
  assert.ok(cut.some(segment => Math.abs(segment.omittedBefore - 0.9) < 0.001));
  assert.ok(kept.some(segment => segment.start === 0 && segment.end === 4.7));
});
