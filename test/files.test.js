import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createCaptureService } from '../src/service.js';
import { run } from '../src/process.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'repro-files-'));
  const token = 'file-tools-test';
  const service = await createCaptureService({ port: 0, token }, { artifactDirectory: path.join(directory, 'artifacts') });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const client = new Client({ name: 'file-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.server.address().port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(async () => { await client.close(); await service.close(); await rm(directory, { recursive: true }); });
  const call = async (name, args) => {
    const result = await client.callTool({ name: `capture_${name}`, arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  return { directory, call };
}

test('file MCP renders CSS-coordinate annotations at source resolution without a Chrome connection', async t => {
  const { directory, call } = await fixture(t);
  const imagePath = path.join(directory, 'source.png');
  const details = [12, 34, 56, 240, 210, 180];
  const stripe = await sharp(Buffer.from(details), { raw: { width: 2, height: 1, channels: 3 } }).png().toBuffer();
  await sharp({ create: { width: 400, height: 200, channels: 3, background: '#fff' } }).composite([{ input: stripe, left: 200, top: 40 }]).png().toFile(imagePath);
  const source = await readFile(imagePath);
  const screenshot = await call('annotate', { imagePath, viewport: { width: 200, height: 100 }, region: { x: 100, y: 20, width: 100, height: 80 }, highlight: [{ target: { x: 110, y: 30, width: 30, height: 20 } }] });
  const { data, info } = await sharp(screenshot.screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 200); assert.equal(info.height, 160);
  assert.deepEqual([...data.subarray(0, details.length)], details, 'Omit resampling when copying the source crop');
  const pixel = (22 * info.width + 22) * info.channels;
  assert.ok(data[pixel] > 200 && data[pixel + 1] < 80, 'Box coordinates and stroke scale with the capture');
  const legend = await call('annotate', { imagePath, viewport: { width: 200, height: 100 }, region: { x: 0, y: 0, width: 40, height: 30 }, highlight: [{ target: { x: 0, y: 0, width: 20, height: 30 }, label: 'First crowded label', style: 'arrow' }, { target: { x: 30, y: 0, width: 10, height: 30 }, label: 'Second crowded label' }] });
  assert.ok(legend.annotations.items.every(item => item.label.footer));
  assert.ok(legend.annotations.height > 30);
  assert.equal(legend.annotations.items[0].style, 'arrow');
  const legendImage = await sharp(legend.screenshot).metadata();
  assert.equal(legendImage.width, 80); assert.equal(legendImage.height, legend.annotations.height * 2);
  assert.deepEqual(await readFile(imagePath), source);
  await assert.rejects(call('annotate', { imagePath, region: { x: 390, y: 0, width: 40, height: 20 } }), /crop must fit/);
});

test('file MCP can place a screenshot label to the right of its target', async t => {
  const { directory, call } = await fixture(t);
  const imagePath = path.join(directory, 'source.png');
  await sharp({ create: { width: 400, height: 200, channels: 3, background: '#fff' } }).png().toFile(imagePath);

  const target = { x: 30, y: 40, width: 40, height: 40 };
  const result = await call('annotate', {
    imagePath,
    viewport: { width: 200, height: 100 },
    highlight: [{ target, label: 'Date range', labelPlacement: 'right' }],
  });

  const { label } = result.annotations.items[0];
  assert.ok(label.x > target.x + target.width);
  assert.equal(label.y + label.height / 2, target.y + target.height / 2);
  const pixel = await sharp(result.screenshot).extract({ left: label.x * 2 + 2, top: label.y * 2 + 2, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  assert.deepEqual([...pixel], [0xc9, 0x12, 0x32]);
});

test('browser observer returned through MCP captures actual events without typed text and cleans up', async t => {
  const { call } = await fixture(t);
  const script = await call('browser_script', { startedAt: new Date(Date.now() - 1000).toISOString() });
  const document = new EventTarget();
  const context = { document, AbortController, innerWidth: 1280, innerHeight: 800 };
  runInNewContext(script.installExpression, context);
  const send = (type, values) => document.dispatchEvent(Object.assign(new Event(type), values));
  send('pointerdown', { clientX: 120, clientY: 200 });
  send('keydown', { key: 'p', getModifierState: () => false });
  send('keydown', { key: 'z', metaKey: true, getModifierState: () => false });
  send('input', { value: 'This field value must not be recorded' });
  const data = JSON.parse(JSON.stringify(runInNewContext(script.readExpression, context)));
  assert.deepEqual(data.events.map(e => e.type), ['pointerdown', 'keydown', 'input']);
  assert.equal(data.events[0].x, 120); assert.equal(data.events[1].keyLabel, 'Cmd+Z');
  assert.ok(data.events.every(e => e.t >= 1));
  assert.ok(!JSON.stringify(data).includes('field value'));
  const events = context.__reproEvidence.events;
  runInNewContext(script.cleanupExpression, context);
  send('pointerdown', { clientX: 300, clientY: 400 });
  assert.equal(events.length, 3); assert.equal(context.__reproEvidence, undefined);
});

test('file MCP exports real recordings with cropped callouts, click rings, keys, and source preservation', async t => {
  const { directory, call } = await fixture(t);
  const videoPath = path.join(directory, 'source.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x400:r=15:d=4', '-vf', "drawbox=color=yellow:t=fill:enable='gte(t,2)'", '-c:v', 'libx264', videoPath]);
  const source = await readFile(videoPath);
  const args = { videoPath, viewport: { width: 320, height: 200 }, region: { x: 10.5, y: 20.5, width: 300.5, height: 160.5 }, preserveTiming: true, events: [{ t: 0.5, type: 'click', x: 60, y: 70 }, { t: 2.5, type: 'keydown', keyLabel: 'Cmd+Z' }], callouts: [{ at: 2.2, holdSeconds: 1, highlight: [{ target: { x: 40, y: 60, width: 80, height: 30 }, label: 'Yellow result', style: 'arrow' }] }] };
  const result = await call('export', args);
  assert.equal(result.calloutCount, 1); assert.equal(result.insertedSeconds, 1);
  assert.equal(result.omittedSeconds, 0); assert.equal(result.clickCount, 1);
  assert.ok(Math.abs(result.outputDurationSeconds - 5) < 0.2);
  assert.deepEqual(await readFile(result.original), source);
  assert.deepEqual(await readFile(videoPath), source);
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
  assert.equal(manifest.video.width, 602); assert.equal(manifest.video.height, 322);
  assert.equal(manifest.keyboard.badges[0].keys[0].label, 'Cmd+Z');
  const { data: callout, info: calloutInfo } = await sharp(result.screenshots[0]).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(calloutInfo.width, 602); assert.equal(calloutInfo.height, 322);
  assert.ok(callout[0] > 200 && callout[1] > 200 && callout[2] < 50, 'Callout extracts the yellow frame at 2.2s');
  const pixels = path.join(directory, 'click.png');
  await run('ffmpeg', ['-v', 'error', '-i', result.clip, '-ss', '0.6', '-frames:v', '1', pixels]);
  const { data, info } = await sharp(pixels).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ring = (99 * info.width + 140) * info.channels;
  assert.ok(data[ring] > 120 && data[ring + 2] < 200, 'Click indicator uses the native scale and crop origin');
  const redAt = (x, y) => data[(y * info.width + x) * info.channels];
  assert.ok(redAt(600, 160) < 150 && redAt(300, 320) < 150, 'Encoding retains the final content row and column');
  assert.ok(redAt(601, 160) > 200 && redAt(300, 321) > 200, 'Only the added padding is white');
  const trimmed = await call('export', { videoPath, callouts: [] });
  assert.ok(trimmed.omittedSeconds > 0.5, 'Imported visual sampling trims static gaps');
  await assert.rejects(call('export', { ...args, callouts: [{ ...args.callouts[0], at: 10 }] }), /timestamps must fall inside/);
});
