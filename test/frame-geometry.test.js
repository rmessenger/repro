import test from 'node:test';
import assert from 'node:assert/strict';
import { frameContentRect, sourceCrop, recordingScale } from '../extension/frame-geometry.js';

test('letterboxed and pillarboxed frames map viewport coordinates into content, not black bars', () => {
  assert.deepEqual(frameContentRect({ width: 1000, height: 800 }, { width: 1000, height: 600 }), { x: 0, y: 100, width: 1000, height: 600, scale: 1 });
  assert.deepEqual(frameContentRect({ width: 1200, height: 600 }, { width: 1000, height: 600 }), { x: 100, y: 0, width: 1000, height: 600, scale: 1 });
  assert.deepEqual(sourceCrop({ width: 2000, height: 1600 }, { viewport: { width: 1000, height: 600 }, region: { x: 100, y: 200, width: 300, height: 100 } }), { x: 200, y: 600, width: 600, height: 200 });
});
test('matching aspect ratios preserve ordinary crops and invalid frames fail explicitly', () => {
  assert.deepEqual(sourceCrop({ width: 2000, height: 1200 }, { viewport: { width: 1000, height: 600 }, region: { x: 100, y: 200, width: 300, height: 100 } }), { x: 200, y: 400, width: 600, height: 200 });
  assert.throws(() => frameContentRect({ width: 0, height: 0 }, { width: 1000, height: 600 }), /positive dimensions/);
});

test('high resolution uses real 2× content and falls back when Chrome supplies fewer pixels', () => {
  const viewport = { width: 1448, height: 1559 };
  const large = { width: 6016, height: 3384 };
  assert.equal(recordingScale('high', large, viewport), 2);
  assert.equal(recordingScale('standard', large, viewport), 1);
  assert.equal(recordingScale('high', { width: 6016, height: 2160 }, viewport), 1);
});
