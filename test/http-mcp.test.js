import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createCaptureService } from '../src/service.js';
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'evidence-http-'));
  const token = 'test-pairing-token';
  const service = await createCaptureService({ port: 0, token }, { artifactDirectory: directory });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const base = `http://127.0.0.1:${service.server.address().port}`;
  t.after(async () => { await service.close(); await rm(directory, { recursive: true }); });
  const connect = async () => {
    const client = new Client({ name: 'http-test', version: '1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    t.after(() => client.close());
    return client;
  };
  return { base, token, connect };
}
test('HTTP MCP initializes without Chrome and advertises evidence tools and actionable setup', async t => {
  const f = await fixture(t), client = await f.connect();
  assert.match(client.getInstructions(), /cropped screenshots/);
  assert.match(client.getInstructions(), /Extension not connected at initialization/);
  assert.match(client.getInstructions(), /Load unpacked/);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 8);
  assert.match(tools.find(t => t.name === 'capture_start').description, /UAT/);
  const result = await client.callTool({ name: 'capture_status', arguments: {} });
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.ready, false);
  assert.equal(status.reason, 'extension_not_connected');
  assert.ok(path.isAbsolute(status.installation.extensionPath));
  assert.match(status.installation.troubleshooting, /cannot distinguish/);
  const failed = await client.callTool({ name: 'capture_start', arguments: { tabId: 1, url: 'https://example.com' } });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /Developer mode/);
});
test('HTTP endpoint rejects missing tokens and browser origins', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.base}/mcp`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${f.base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(`${f.base}/health`, { headers: { Authorization: `Bearer ${f.token}` } })).status, 200);
});
test('two HTTP clients share one extension and an approval wait does not block another client', async t => {
  const f = await fixture(t);
  const extension = new WebSocket(f.base.replace('http:', 'ws:'), { origin: 'chrome-extension://test' });
  await once(extension, 'open');
  extension.send(JSON.stringify({ type: 'hello', token: f.token, version: '0.12.0', automaticFraming: true }));
  let waiting;
  const waitReceived = new Promise(resolve => { waiting = resolve; });
  extension.on('message', bytes => {
    const message = JSON.parse(bytes);
    switch (message.command) {
      case 'wait': waiting(message); break;
      default: extension.send(JSON.stringify({ id: message.id, result: { sessionId: message.args.sessionId, enabled: true, recording: true } }));
    }
  });
  const a = await f.connect(), b = await f.connect();
  const sessionA = crypto.randomUUID(), sessionB = crypto.randomUUID();
  const wait = a.callTool({ name: 'capture_wait', arguments: { sessionId: sessionA, requestId: crypto.randomUUID(), seconds: 50 } });
  const pending = await waitReceived;
  const status = await b.callTool({ name: 'capture_status', arguments: { sessionId: sessionB } });
  assert.equal(JSON.parse(status.content[0].text).sessionId, sessionB);
  extension.send(JSON.stringify({ id: pending.id, result: { sessionId: sessionA, recording: true } }));
  assert.equal(JSON.parse((await wait).content[0].text).sessionId, sessionA);
  extension.close();
});
test('disconnects report ambiguous command completion and malformed sockets cannot crash the service', async t => {
  const f = await fixture(t);
  const invalid = new WebSocket(f.base.replace('http:', 'ws:'), { origin: 'chrome-extension://test' });
  await once(invalid, 'open'); invalid.send('null');
  assert.equal((await once(invalid, 'close'))[0], 1008);
  assert.equal((await fetch(`${f.base}/health`, { headers: { Authorization: `Bearer ${f.token}` } })).status, 200);
  const extension = new WebSocket(f.base.replace('http:', 'ws:'), { origin: 'chrome-extension://test' });
  await once(extension, 'open'); extension.send(JSON.stringify({ type: 'hello', token: f.token }));
  extension.on('message', () => extension.close());
  const client = await f.connect();
  const result = await client.callTool({ name: 'capture_wait', arguments: { sessionId: crypto.randomUUID(), requestId: crypto.randomUUID(), seconds: 50 } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /may have executed/);
  const status = await client.callTool({ name: 'capture_status', arguments: {} });
  assert.equal(JSON.parse(status.content[0].text).extensionConnected, false);
});

test('live MCP results direct agents to wait and proceed without chat confirmation', async t => {
  const f = await fixture(t);
  const extension = new WebSocket(f.base.replace('http:', 'ws:'), { origin: 'chrome-extension://test' });
  await once(extension, 'open');
  t.after(() => extension.close());
  extension.send(JSON.stringify({ type: 'hello', token: f.token, automaticFraming: true }));
  const sessionId = crypto.randomUUID(), requestId = crypto.randomUUID();
  const pending = { sessionId, recording: false, approval: { requestId, state: 'awaiting_approval' } };
  const responses = [{ sessionId, requestId, state: 'awaiting_approval' }, pending, pending, { sessionId, recording: true }];
  extension.on('message', bytes => extension.send(JSON.stringify({ id: JSON.parse(bytes).id, result: responses.shift() })));
  const client = await f.connect();
  const start = JSON.parse((await client.callTool({ name: 'capture_start', arguments: { tabId: 1, url: 'https://example.com' } })).content[0].text);
  assert.deepEqual(start.agentNextStep.arguments, { sessionId, requestId, seconds: 50 });
  assert.equal(start.agentNextStep.tool, 'capture_wait');
  assert.match(start.agentNextStep.instruction, /no reminder is needed yet/);
  assert.match(start.agentNextStep.instruction, /Do not ask for a chat reply/);
  const short = JSON.parse((await client.callTool({ name: 'capture_wait', arguments: { sessionId, requestId, seconds: 0 } })).content[0].text);
  assert.match(short.agentNextStep.instruction, /no reminder is needed yet/);
  const timeout = JSON.parse((await client.callTool({ name: 'capture_wait', arguments: { sessionId, requestId, seconds: 50 } })).content[0].text);
  assert.match(timeout.agentNextStep.instruction, /non-blocking reminder/);
  const approved = JSON.parse((await client.callTool({ name: 'capture_wait', arguments: { sessionId, requestId, seconds: 50 } })).content[0].text);
  assert.equal(approved.recording, true);
  assert.match(approved.agentNextStep, /Continue browser interactions now/);
  assert.match(approved.agentNextStep, /do not wait for a chat reply/);
});
