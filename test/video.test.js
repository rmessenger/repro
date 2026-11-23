import sharp from 'sharp';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cursorAt } from '../src/cursor.js';
import { processVideo, run } from '../src/process.js';
test('real encoding produces a playable shortened MP4, original, and timing manifest', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'evidence-video-'));
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=15:d=12', '-c:v', 'libvpx-vp9', path.join(directory, 'original.webm')]);
  const result = await processVideo(directory, { duration: 12, samples: [], events: [{ t: 1, type: 'pointerdown' }, { t: 10, type: 'pointerdown' }], warnings: [] });
  assert.ok(result.omittedSeconds > 5);
  const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', result.clip]));
  assert.equal(probe.streams[0].codec_name, 'h264');
  assert.equal(probe.streams[0].width, 320);
  assert.ok(Number(probe.format.duration) < 7);
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
  assert.ok(manifest.timeline[1].omittedBefore > 5);
  assert.equal(result.clickCount, 2);
});
test('preserveTiming output retains the source duration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'evidence-timing-'));
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=320x240:r=15:d=4', '-c:v', 'libvpx-vp9', path.join(directory, 'original.webm')]);
  const result = await processVideo(directory, { duration: 4, samples: [], events: [], warnings: [], preserveTiming: true });
  assert.equal(result.omittedSeconds, 0);
  const duration = Number(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', result.clip]));
  assert.ok(Math.abs(duration - 4) < 0.2);
});
for (const preserveTiming of [false, true]) test(`export inserts callout frames without losing following action (preserveTiming=${preserveTiming})`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'evidence-callout-'));
  const sessionId = crypto.randomUUID(), calloutId = crypto.randomUUID();
  const imageDirectory = path.join(directory, calloutId);
  await mkdir(imageDirectory);
  await writeFile(path.join(imageDirectory, 'manifest.json'), JSON.stringify({ sessionId }));
  await sharp({ create: { width: 320, height: 240, channels: 3, background: 'red' } }).png().toFile(path.join(imageDirectory, 'screenshot.png'));
  const original = path.join(directory, 'original.webm');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=15:d=12', '-vf', "drawbox=color=yellow:t=fill:enable='gte(t,4)'", '-c:v', 'libvpx-vp9', original]);
  const before = await readFile(original);
  const result = await processVideo(directory, { sessionId, duration: 12, samples: [], events: [], warnings: [], preserveTiming, callouts: [{ at: 4, holdSeconds: 3, calloutId, mode: 'inserted-freeze-frame', label: 'Read this' }] }, { calloutRoot: directory });
  assert.deepEqual(await readFile(original), before);
  assert.equal(result.insertedSeconds, 3);
  assert.equal(result.calloutCount, 1);
  assert.ok(Math.abs(result.outputDurationSeconds - (result.keptSeconds + 3)) < 0.15);
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
  const index = manifest.playback.findIndex(segment => segment.type === 'callout');
  assert.equal(manifest.playback[index - 1].endFrame, manifest.playback[index + 1].startFrame);
  const stats = await run('ffmpeg', ['-v', 'error', '-i', result.clip, '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-']);
  const values = [...stats.matchAll(/lavfi.signalstats.YAVG=([\d.]+)/g)].map(match => Number(match[1]));
  assert.equal(values.filter(value => value > 75 && value < 85).length, 45);
  const lastRed = values.findLastIndex(value => value > 75 && value < 85);
  assert.ok(values[lastRed + 1] > 200, 'The next source action follows the inserted callout');
  assert.ok(values.slice(0, values.findIndex(value => value > 75 && value < 85)).every(value => value < 50));
  await assert.rejects(processVideo(directory, { sessionId: crypto.randomUUID(), duration: 12, samples: [], events: [], callouts: [{ at: 4, holdSeconds: 3, calloutId }] }, { calloutRoot: directory }), /another capture session/);
});
test('rapid keyboard events remain readable after immediate stop without changing the source recording', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'evidence-keys-'));
  const original = path.join(directory, 'original.webm');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=100x40:r=15:d=4', '-c:v', 'libvpx-vp9', original]);
  const before = await readFile(original);
  const result = await processVideo(directory, { duration: 4, samples: [], events: [{ type: 'keydown', keyLabel: 'Tab', t: 3.9 }, { type: 'keydown', keyLabel: 'Enter', t: 3.91 }, { type: 'keydown', keyLabel: 'Tab', t: 3.92 }], warnings: [], preserveTiming: true });
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
  assert.deepEqual(manifest.keyboard.badges[0].rows, ['Tab → Enter → Tab']);
  assert.ok(manifest.keyboardTailSeconds > 1.4);
  assert.ok(result.outputDurationSeconds >= manifest.keyboard.badges[0].end - 0.07);
  const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', result.clip]));
  assert.equal(probe.streams[0].width, 320);
  assert.ok(probe.streams[0].height > 40);
  assert.deepEqual(await readFile(original), before);
});
test('export holds a real pre-edit frame, highlights the field, and keeps the following state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'repro-editing-'));
  const original = path.join(directory, 'original.webm');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=15:d=4', '-vf', "drawbox=color=yellow:t=fill:enable='gte(t,1)'", '-c:v', 'libvpx-vp9', original]);
  const before = await readFile(original);
  const field = { id: 1, rect: { x: 40, y: 80, width: 120, height: 35 } };
  const result = await processVideo(directory, { duration: 4, samples: [], events: [{ type: 'pointerdown', t: 0.7 }, { type: 'input', t: 1, field }, { type: 'keydown', t: 1.5, keyLabel: 'Tab' }], geometry: { region: { x: 0, y: 0, width: 320, height: 240 } }, warnings: [] });
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
  assert.equal(manifest.editing.holds.length, 1);
  assert.equal(manifest.editing.overlays[0].label, 'Next: edit');
  assert.equal(manifest.editing.overlays[1].label, 'Editing');
  assert.equal(manifest.automaticHoldSeconds, 8 / 15);
  const stats = await run('ffmpeg', ['-v', 'error', '-i', result.clip, '-vf', 'crop=20:20:280:20,signalstats,metadata=print:file=-', '-f', 'null', '-']);
  const values = [...stats.matchAll(/lavfi.signalstats.YAVG=([\d.]+)/g)].map(match => Number(match[1]));
  assert.equal(values.findIndex(value => value > 200), 23, '15 original blue frames plus 8 held frames precede yellow');
  assert.ok(values.slice(0, 23).every(value => value < 50));
  assert.ok(values.slice(23).every(value => value > 200));
  assert.deepEqual(await readFile(original), before);
});
test('simulated cursor encodes with smooth travel, ordered rapid clicks, and unchanged source', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'repro-cursor-'));
  const original = path.join(directory, 'original.webm');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=320x240:r=15:d=12', '-c:v', 'libvpx-vp9', original]);
  const before = await readFile(original);
  const pointerSamples = [{ t: 1.01, x: 30, y: 40, type: 'pointerdown' }, { t: 1.02, x: 260, y: 160, type: 'pointerdown' }, { t: 1.03, x: 50, y: 180, type: 'pointerdown' }, { t: 10, x: 200, y: 40, type: 'pointerdown' }];
  const result = await processVideo(directory, { duration: 12, samples: [], events: [...pointerSamples, { type: 'input', t: 10.2, field: { id: 1, rect: { x: 100, y: 100, width: 100, height: 40 } } }], pointerSamples, animateCursor: true, cursorSuppression: { safeForAnimation: true }, geometry: { region: { x: 0, y: 0, width: 320, height: 240 } }, warnings: [] });
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
  assert.equal(manifest.cursor.enabled, true);
  assert.equal(manifest.cursor.clicks.length, 4);
  assert.ok(manifest.cursorHoldSeconds > 0.8);
  const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', result.clip]));
  assert.equal(probe.streams[0].r_frame_rate, '30/1');
  const click = manifest.cursor.clicks[1];
  const png = path.join(directory, 'arrival.png');
  await run('ffmpeg', ['-v', 'error', '-ss', String(click.t + 0.04), '-i', result.clip, '-frames:v', '1', png]);
  const pixels = await sharp(png).removeAlpha().raw().toBuffer();
  const offset = ((160 + 7) * 320 + 260 + 4) * 3;
  assert.ok(pixels[offset] < 100, 'The encoded pointer is at the second click target');
  const old = ((40 + 7) * 320 + 30 + 4) * 3;
  assert.ok(pixels[old] > 220, 'No stale pointer remains at the first target');
  const motion = manifest.cursor.movements[1];
  const times = [manifest.cursor.clicks[0].t + 0.04, motion.start + (motion.end - motion.start) * 0.25, motion.start + (motion.end - motion.start) * 0.5, motion.start + (motion.end - motion.start) * 0.75];
  for (const time of times) {
    const n = Math.ceil(time * 30);
    const expected = cursorAt(manifest.cursor, n / 30);
    await run('ffmpeg', ['-y', '-v', 'error', '-i', result.clip, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', png]);
    const encoded = await sharp(png).removeAlpha().raw().toBuffer();
    const pixel = ((Math.floor(expected.y) + 7) * 320 + Math.floor(expected.x) + 4) * 3;
    assert.ok(encoded[pixel] < 120, `Frame ${n} matches its planned cursor position`);
  }
  const late = manifest.cursor.clicks.at(-1);
  await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(late.t + 0.08), '-i', result.clip, '-frames:v', '1', png]);
  const latePixels = await sharp(png).removeAlpha().raw().toBuffer();
  assert.ok(latePixels[((40 + 7) * 320 + 200 + 4) * 3] < 100, 'The sprite survives a longer clip with editing overlays');
  assert.deepEqual(await readFile(original), before);
});
test('field changes keep typed frames, click arrivals, and editing highlights in order', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'repro-field-order-'));
  const original = path.join(directory, 'original.webm');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=320x240:r=15:d=3', '-vf', "drawbox=x=260:y=180:w=20:h=20:color=blue:t=fill:enable='gte(t,1)'", '-c:v', 'libvpx-vp9', original]);
  const first = { id: 1, rect: { x: 40, y: 80, width: 100, height: 35 } };
  const last = { id: 2, rect: { x: 180, y: 80, width: 100, height: 35 } };
  const pointerSamples = [{ t: 0.59, x: 90, y: 95, type: 'pointerdown' }, { t: 1.015, x: 230, y: 95, type: 'pointerdown' }];
  const events = [{ ...pointerSamples[0], field: first }, { type: 'input', t: 0.61, field: first }, { type: 'input', t: 0.8, field: first }, { ...pointerSamples[1], field: last }, { type: 'focusin', t: 1.016, field: last }, { type: 'input', t: 1.055, field: last }];
  const result = await processVideo(directory, { duration: 3, samples: [], events, pointerSamples, animateCursor: true, cursorSuppression: { safeForAnimation: true }, geometry: { region: { x: 0, y: 0, width: 320, height: 240 } }, warnings: [] });
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
  const resumed = manifest.playback.find(s => s.type === 'video' && s.startFrame === 15);
  assert.ok(resumed.outputStart - manifest.cursor.clicks[1].t >= 0.199);
  const png = path.join(directory, 'field-change.png');
  const n = Math.round(resumed.outputStart * 30);
  await run('ffmpeg', ['-v', 'error', '-i', result.clip, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', png]);
  const pixels = await sharp(png).removeAlpha().raw().toBuffer();
  const pixel = (x, y) => [...pixels.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
  assert.ok(pixel(270, 190)[2] > 150 && pixel(270, 190)[0] < 80, 'The first changed source frame is visible');
  assert.ok(pixel(38, 95).every(channel => channel > 200), 'The previous field highlight does not reappear');
  assert.ok(pixel(178, 95)[0] > 150 && pixel(178, 95)[1] < 130, 'The new field is highlighted on its first changed frame');
});

test('cursor export retains both sides of a foreground reload and stays off the unverified gap', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'repro-cursor-reload-'));
  const original = path.join(directory, 'original.webm');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=320x240:r=15:d=5', '-c:v', 'libvpx-vp9', original]);
  const pointerSamples = [{ t: 1, x: 65, y: 75 }, { t: 2.3, x: 160, y: 120 }, { t: 3.5, x: 245, y: 150 }]
    .map(click => ({ ...click, type: 'pointerdown', tabActive: true }));
  const result = await processVideo(directory, {
    duration: 5, captureStartedAt: 10000, samples: [], events: pointerSamples, pointerSamples, preserveTiming: true,
    animateCursor: true, cursorSuppression: { requested: false, safeForAnimation: false },
    cursorCoverage: { source: 'tab', knownOverlay: true, spans: [
      { from: 9700, through: 12000, points: [[11000, 65, 75, 1]] },
      { from: 12900, through: 15100, points: [[13500, 245, 150, 1]] },
    ] },
    geometry: { tabActive: true, region: { x: 0, y: 0, width: 320, height: 240 } },
  });
  const { cursor, cursorSource } = JSON.parse(await readFile(result.manifest, 'utf8'));
  assert.equal(cursorSource.foregroundSamples, 2);
  assert.equal(cursorSource.ringOnlyClicks, 1);
  assert.equal(cursor.clicks.length, 3);
  assert.equal(cursorAt(cursor, 2.4), null);
  const png = path.join(directory, 'cursor.png');
  const grab = async (t, x, y) => {
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-i', result.clip, '-frames:v', '1', png]);
    const pixels = await sharp(png).removeAlpha().raw().toBuffer();
    const i = ((y + 7) * 320 + x + 4) * 3;
    return [...pixels.subarray(i, i + 3)];
  };
  assert.ok((await grab(1.1, 65, 75))[0] < 100);
  assert.ok((await grab(2.4, 65, 75)).every(channel => channel > 220));
  assert.ok((await grab(2.4, 160, 120)).every(channel => channel > 220));
  assert.ok((await grab(3.6, 245, 150))[0] < 100);
});
