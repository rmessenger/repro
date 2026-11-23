import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { planFraming } from '../src/framing.js';
import { run } from '../src/process.js';
import { recordingParts, saveRecording } from '../src/recording-upload.js';

const viewport = { width: 1000, height: 600 };
const geometry = { viewport, region: { x: 0, y: 0, ...viewport } };
const click = { type: 'pointerdown', x: 752, y: 42, t: 0.8, targetRect: { x: 698, y: 22, width: 108, height: 40 } };
const field = { id: 1, rect: { x: 696, y: 98, width: 230, height: 34 } };
const outcome = { t: 4, rect: { x: 700, y: 208, width: 255, height: 81 } };
const metadata = { geometry, framing: 'auto', events: [click, { type: 'input', t: 1, field }, { type: 'pointermove', t: 2, x: 1, y: 599 }], includes: [outcome] };

test('auto framing covers entire targets and explicit results and ignores mouse travel', () => {
  const frame = planFraming(metadata, viewport);
  assert.equal(frame.reason, 'interaction-bounds');
  assert.equal(frame.region.y, 0);
  assert.ok(frame.region.x <= click.targetRect.x - 56);
  assert.ok(frame.region.x >= 460);
  assert.ok(frame.region.y + frame.region.height >= outcome.rect.y + outcome.rect.height + 56);
  assert.deepEqual(frame.anchors, { clicks: 1, edits: 1, callouts: 0, included: 1 });
  assert.equal(planFraming({ ...metadata, includes: [], events: [click] }, viewport).reason, 'limited-evidence');
  assert.equal(planFraming({ ...metadata, viewportChanged: true }, viewport).reason, 'viewport-changed');
});

test('export frames the actual video and annotated still, removes temporary sources, and tolerates a retried stop', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'repro-export-framing-'));
  t.after(() => rm(workspace, { force: true, recursive: true }));
  const seed = path.join(workspace, 'fixture.webm');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=1000x600:r=15:d=8', '-vf', "drawbox=x=12:y=12:w=220:h=160:color=black:t=fill:enable='lt(mod(t,0.4),0.2)'", '-c:v', 'libvpx-vp9', seed]);
  const video = await readFile(seed);
  const png = await sharp({ create: { ...viewport, channels: 3, background: 'white' } }).composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600"><rect x="700" y="180" width="160" height="20" fill="red"/></svg>') }]).png().toBuffer();
  const bundle = {
    ...metadata, events: metadata.events.slice(0, 2), duration: 8, recordingId: crypto.randomUUID(), sessionId: crypto.randomUUID(), samples: [],
    callouts: [{ at: 4.1, holdSeconds: 1, geometry: { ...geometry, highlights: [{ rect: outcome.rect }] }, annotations: { items: [{ label: { x: 700, y: 180, width: 160, height: 20 } }] } }],
    videoBytes: video.length, calloutSizes: [png.length],
  };
  const directory = path.join(workspace, bundle.recordingId);
  const raw = path.join(directory, 'original.webm');
  const bad = Buffer.from('corrupt video');
  await assert.rejects(saveRecording(directory, { ...bundle, videoBytes: bad.length }, [bad, png]), /Retry capture_stop/);
  assert.deepEqual(await readFile(raw), bad);
  const parts = recordingParts(bundle, Buffer.concat([video, png]));
  assert.throws(() => recordingParts(bundle, video), /payload lengths/);
  const result = await saveRecording(directory, bundle, parts);
  assert.equal(result.framing.reason, 'interaction-bounds');
  assert.ok(result.omittedSeconds > 1, 'Activity outside the crop does not keep idle footage');
  assert.ok(result.insertedSeconds >= 1);
  assert.equal(result.original, undefined);
  await assert.rejects(readFile(raw), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(directory, 'source-callout-1.png')), { code: 'ENOENT' });
  const { pixels } = result.framing;
  const still = sharp(path.join(directory, 'callout-1.png'));
  const { width, height } = await still.metadata();
  assert.deepEqual({ width, height }, { width: pixels.width, height: pixels.height });
  const marker = await still.extract({ left: 715 - pixels.x, top: 190 - pixels.y, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  assert.deepEqual([...marker], [255, 0, 0]);
  assert.deepEqual(await saveRecording(directory, bundle, parts), result);
  await assert.rejects(readFile(raw), { code: 'ENOENT' });
});
