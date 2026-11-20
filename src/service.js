import http from 'node:http';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { root, artifacts } from './config.js';
import { createMcpServer, version } from './mcp-tools.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { schemas } from './schema.js';
import { processVideo } from './process.js';
import { annotateFile, exportFile } from './files.js';
import { browserScript } from './browser-events.js';
export async function createCaptureService(settings, { artifactDirectory = artifacts } = {}) {
await mkdir(artifactDirectory, { recursive: true });
const extensionPath = path.join(root, 'dist/extension');
const installation = {
  extensionPath,
  steps: ['Open Chrome and visit chrome://extensions.', 'Enable Developer mode.', `Click Load unpacked and select ${extensionPath}.`, 'Accept website access so approval banners can appear before you click REC. Recording still needs your separate REC click.', 'Pin Repro using Chrome’s Extensions menu. Leave Chrome open; the extension connects automatically.'],
  troubleshooting: 'After a service restart, allow a few seconds for automatic reconnection before asking the user to reload anything. If already installed, check that Repro is enabled and reload it in chrome://extensions. Connection status cannot distinguish an uninstalled extension from closed Chrome, a disabled extension, or a connection failure.',
  agentAction: 'Walk the user through these steps. Do not try to install the extension or approve capture on their behalf. Once connected, retry capture_status, then request a tab through capture_start.',
};
const readiness = () => ({ service: 'repro', version, fileToolsReady: true, extensionConnected: extension?.readyState === 1, extensionVersion, extensionPath });
let extensionVersion;
let extension;
const pending = new Map();
function failPending(message) {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
  pending.clear();
}
const secureEqual = value => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(settings.token) && timingSafeEqual(Buffer.from(value), Buffer.from(settings.token));
const authorized = request => secureEqual(request.headers.authorization?.replace(/^Bearer /, ''));
function reply(response, code, value) { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); }
async function body(request, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error('Request exceeds capture size limit.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function command(name, args) {
  if (name === 'browser_script') return browserScript(args);
  if (name === 'annotate') return annotateFile(args, artifactDirectory);
  if (name === 'export') return exportFile(args, artifactDirectory);
  if (!extension || extension.readyState !== 1) {
    const result = { ...readiness(), ready: false, reason: 'extension_not_connected', installation };
    if (name === 'status') return result;
    throw new Error(JSON.stringify(result));
  }
  const id = randomUUID();
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Capture command timed out; use status to inspect the session.')); }, 180000);
    pending.set(id, { resolve, reject, timer });
    extension.send(JSON.stringify({ id, command: name, args }));
  });
  return name === 'status' ? result.then(status => ({ ...readiness(), ready: true, ...status })) : result;
}
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${settings.port}`);
    if (request.headers.host !== `127.0.0.1:${server.address().port}`) return reply(response, 403, { error: 'Invalid host.' });
    if (url.pathname === '/demo' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(await readFile(path.join(root, url.searchParams.has('cursor') ? 'demo/cursor.html' : url.searchParams.has('composer') ? 'demo/composer.html' : 'demo/index.html'))); return;
    }
    if (!authorized(request)) return reply(response, 401, { error: 'Unauthorized.' });
    if (request.headers.origin && !request.headers.origin.startsWith('chrome-extension://')) return reply(response, 403, { error: 'Browser page requests are not accepted.' });
    if (url.pathname === '/health' && request.method === 'GET') return reply(response, 200, readiness());
    if (url.pathname === '/mcp') {
      if (request.headers.origin) return reply(response, 403, { error: 'MCP accepts local agent clients, not browser pages.' });
      if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); return reply(response, 405, { error: 'Use MCP POST requests.' }); }
      const payload = JSON.parse((await body(request, 1024 * 1024)).toString());
      const mcp = createMcpServer(command, extension?.readyState === 1 ? '' : `Extension not connected at initialization. File tools capture_browser_script, capture_annotate, and capture_export remain available. For Chrome capture tools only: ${installation.troubleshooting} Help the user: ${installation.steps.join(' ')}`);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const finished = new Promise(resolve => response.once('close', resolve));
      try {
        await mcp.connect(transport);
        await transport.handleRequest(request, response, payload);
        await finished;
      } finally { await mcp.close(); }
      return;
    }
    if (url.pathname === '/command' && request.method === 'POST') {
      const data = JSON.parse((await body(request, 1024 * 1024)).toString());
      if (!Object.hasOwn(schemas, data.command)) return reply(response, 400, { error: 'Unknown command.' });
      const args = schemas[data.command].parse(data.args || {});
      return reply(response, 200, await command(data.command, args));
    }
    if (url.pathname === '/upload' && request.method === 'POST') {
      const kind = url.searchParams.get('kind');
      if (!['video', 'screenshot', 'callout'].includes(kind)) throw new Error('Invalid artifact type.');
      const payload = await body(request, 150 * 1024 * 1024);
      if (payload.length < 4) throw new Error('Invalid capture payload.');
      const metadataLength = payload.readUInt32BE(0);
      if (metadataLength > 1024 * 1024 || metadataLength + 4 >= payload.length) throw new Error('Invalid capture metadata length.');
      const metadata = JSON.parse(payload.subarray(4, 4 + metadataLength).toString());
      const directory = path.join(artifactDirectory, randomUUID()); await mkdir(directory);
      const bytes = payload.subarray(4 + metadataLength);
      if (kind === 'screenshot' || kind === 'callout') {
        const file = path.join(directory, 'screenshot.png'); await writeFile(file, bytes);
        await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(metadata, null, 2));
        if (kind === 'callout') return reply(response, 200, { calloutId: path.basename(directory) });
        return reply(response, 200, { screenshot: file, region: metadata.geometry.region, warnings: metadata.warnings });
      }
      await writeFile(path.join(directory, 'original.webm'), bytes);
      await writeFile(path.join(directory, 'capture.json'), JSON.stringify(metadata, null, 2));
      return reply(response, 200, await processVideo(directory, metadata, { calloutRoot: artifactDirectory }));
    }
    reply(response, 404, { error: 'Not found.' });
  } catch (error) {
    if (!response.headersSent) reply(response, 400, { error: error.message });
    else response.destroy(error);
  }
});
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });
wss.on('connection', (socket, request) => {
  if (!request.headers.origin?.startsWith('chrome-extension://')) { socket.close(1008, 'Extension required'); return; }
  let authenticated = false;
  socket.alive = true;
  socket.on('pong', () => { socket.alive = true; });
  const timer = setTimeout(() => socket.close(1008, 'Authentication required'), 3000);
  socket.on('message', bytes => {
    let message;
    try { message = JSON.parse(bytes.toString()); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      socket.close(1008, 'Invalid message'); return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.close(1008, 'Invalid message'); return; }
    if (!authenticated) {
      if (message.type !== 'hello' || !secureEqual(message.token)) { socket.close(1008, 'Unauthorized'); return; }
      authenticated = true; clearTimeout(timer);
      if (extension) { failPending('Capture connection replaced. The command may have executed; inspect session status before retrying.'); extension.close(1000, 'Reconnected'); }
      extension = socket; extensionVersion = message.version; return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.result);
  });
  socket.on('close', () => {
    clearTimeout(timer);
    if (extension !== socket) return;
    extension = null;
    failPending('Capture extension disconnected. The command may have executed; reconnect and inspect session status before retrying.');
  });
});
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.alive) { socket.terminate(); continue; }
    socket.alive = false; socket.ping();
  }
}, 30000);
heartbeat.unref();
return {
  server,
  async close() {
    clearInterval(heartbeat);
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
    server.closeIdleConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  },
};
}
