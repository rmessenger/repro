import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
test('offscreen connects without runtime APIs unavailable in offscreen documents', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'evidence-offscreen-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL('../extension/', import.meta.url), directory, { recursive: true });
  await cp(new URL('../src/timeline.js', import.meta.url), path.join(directory, 'analysis.js'));
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(directory, 'config.js'), 'export const settings = {port:47321,token:"test-token",extensionVersion:"0.6.1"};');
  const connections = [], messages = [];
  t.mock.method(globalThis, 'setInterval', () => 0);
  globalThis.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({}) } };
  t.after(() => { delete globalThis.chrome; });
  t.mock.property(globalThis, 'WebSocket', class {
    constructor() { connections.push(this); }
    send(message) { messages.push(JSON.parse(message)); }
  });
  await import(pathToFileURL(path.join(directory, 'offscreen.js')));
  connections[0].onopen();
  assert.deepEqual(messages, [{ type: 'hello', token: 'test-token', version: '0.6.1', automaticFraming: true }]);
});
