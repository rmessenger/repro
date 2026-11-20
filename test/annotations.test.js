import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutAnnotations, overlaps } from '../extension/annotations.js';
import { schemas } from '../src/schema.js';
const measure = text => text.length * 8;
const canvas = { width: 1672, height: 982 };
const geometry = highlights => ({ region: { x: 0, y: 0, width: 1672, height: 982 }, highlights });
const highlights = [
  { rect: { x: 900, y: 236, width: 75, height: 44 }, label: 'Stored handle is missing from this connected account', style: 'box' },
  { rect: { x: 1100, y: 238, width: 110, height: 43 }, label: 'Account is connected', style: 'box' },
];
test('nearby long labels wrap and do not overlap each other or either target', () => {
  const result = layoutAnnotations(geometry(highlights), canvas, measure);
  assert.ok(result.items[0].label.lines.length > 1);
  assert.equal(overlaps(result.items[0].label, result.items[1].label), false);
  for (const item of result.items) for (const other of result.items) assert.equal(overlaps(item.label, other.rect), false);
  assert.equal(result.height, canvas.height);
});
test('labels at the image edge remain inside the image', () => {
  const result = layoutAnnotations(geometry([{ rect: { x: 1600, y: 0, width: 72, height: 20 }, label: 'A long label near the right edge' }]), canvas, measure);
  const label = result.items[0].label;
  assert.ok(label.x >= 0 && label.y >= 0);
  assert.ok(label.x + label.width <= canvas.width);
  assert.ok(label.y + label.height <= result.height);
});
test('a blocked right-side label falls back to automatic placement', () => {
  const target = { rect: { x: 100, y: 100, width: 60, height: 40 }, label: 'Date range' };
  const blocker = { rect: { x: 170, y: 100, width: 100, height: 40 } };
  const normal = layoutAnnotations(geometry([target, blocker]), canvas, measure);
  const preferred = layoutAnnotations(geometry([{ ...target, labelPlacement: 'right' }, blocker]), canvas, measure);
  assert.deepEqual(preferred, normal);
  assert.ok(preferred.items[0].label.y + preferred.items[0].label.height < target.rect.y);
});
test('crowded crops use a separate numbered legend instead of overlapping labels', () => {
  const result = layoutAnnotations({ region: { x: 100, y: 200, width: 100, height: 30 }, highlights: [
    { rect: { x: 100, y: 200, width: 50, height: 30 }, label: 'First very long annotation' },
    { rect: { x: 150, y: 200, width: 50, height: 30 }, label: 'Second very long annotation' },
  ] }, { width: 100, height: 30 }, measure);
  assert.ok(result.items.every(item => item.label.footer));
  assert.equal(overlaps(result.items[0].label, result.items[1].label), false);
  assert.ok(result.items[0].label.lines[0].startsWith('1.'));
  assert.ok(result.height > 30);
  assert.deepEqual(result.items[1].rect, { x: 50, y: 0, width: 50, height: 30 });
});
test('targets outside a crop fail clearly, while partially visible targets are clipped', () => {
  const g = { region: { x: 100, y: 200, width: 100, height: 100 }, highlights: [{ rect: { x: 80, y: 220, width: 40, height: 40 } }] };
  assert.deepEqual(layoutAnnotations(g, { width: 200, height: 200 }, measure).items[0].rect, { x: 0, y: 40, width: 40, height: 80 });
  assert.throws(() => layoutAnnotations({ ...g, highlights: [{ rect: { x: 0, y: 0, width: 20, height: 20 } }] }, canvas, measure), /outside the screenshot crop/);
});
test('screenshots support exact visible text targets without guessed coordinates', () => {
  const result = schemas.screenshot.parse({ sessionId: '12345678-1234-4234-8234-123456789012', highlight: [{ target: { text: 'Connected' }, label: 'Account is connected' }] });
  assert.deepEqual(result.highlight[0].target, { text: 'Connected' });
});
