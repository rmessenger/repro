import { settings } from './config.js';
import { createRecorder } from './recorder.js';
import { Sessions } from './sessions.js';
import { approvedTarget } from './approval-state.js';
let socket;
async function background(type, options = {}) {
  const response = await chrome.runtime.sendMessage({ destination: 'background', type, options });
  if (response.error) throw new Error(response.error);
  return response.result;
}
const sessions = new Sessions((sessionId, tabId) => createRecorder(sessionId, (type, options) => background(type, { ...options, sessionId, tabId })));
async function scopedStatus(sessionId) {
  return { ...sessions.get(sessionId).recorder.status(), approval: await background('approvalStatus', { sessionId }) };
}
async function command(name, args = {}) {
  if (name === 'status') return args.sessionId ? scopedStatus(args.sessionId) : sessions.counts();
  if (name === 'wait') {
    const deadline = Date.now() + args.seconds * 1000;
    let result = await scopedStatus(args.sessionId);
    if (result.approval?.requestId !== args.requestId) throw new Error('Unknown requestId for this session.');
    while (['queued', 'awaiting_approval', 'starting'].includes(result.approval.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      result = await scopedStatus(args.sessionId);
      if (result.approval?.requestId !== args.requestId) throw new Error('This capture request was replaced.');
    }
    return result;
  }
  let entry;
  if (name === 'start' && !args.sessionId) {
    if (!args.tabId || !args.url) throw new Error('Provide tabId and url for a new capture session.');
    approvedTarget(args.url, args.url);
    entry = sessions.create(args.tabId);
    args = { ...args, sessionId: entry.sessionId };
  } else entry = sessions.get(args.sessionId);
  if (args.tabId && args.tabId !== entry.tabId) throw new Error('The tabId does not belong to this session.');
  return sessions.run(entry.sessionId, async () => {
    if (name === 'start' && !entry.recorder.status().enabled) {
      if (!args.url) throw new Error('Provide the current url to request approval again.');
      return { sessionId: entry.sessionId, ...await background('requestCapture', { ...args, tabId: entry.tabId }) };
    }
    if (name === 'release') {
      // Cancel approval first so an in-flight user click cannot enable a released session.
      const status = entry.recorder.status();
      if (status.recording || status.completed) throw new Error('Finish and retrieve the recording with stop first.');
      await background('released', { sessionId: entry.sessionId });
      await entry.recorder.command('release');
      sessions.remove(entry.sessionId);
      return { sessionId: entry.sessionId, released: true };
    }
    const result = await entry.recorder.command(name, args);
    if (['start', 'screenshot', 'callout', 'include'].includes(name)) await background('captureReady', { sessionId: entry.sessionId, recording: entry.recorder.status().recording });
    return result;
  });
}
function connect() {
  const connection = new WebSocket(`ws://127.0.0.1:${settings.port}`);
  socket = connection;
  connection.onopen = () => connection.send(JSON.stringify({ type: 'hello', token: settings.token, version: settings.extensionVersion, automaticFraming: true, automaticResolution: true }));
  connection.onmessage = async event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    let response;
    try { response = { id: message.id, result: await command(message.command, message.args) }; }
    catch (error) { response = { id: message.id, error: error.message }; }
    if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(response));
  };
  connection.onclose = () => setTimeout(connect, 1500);
}
connect();
setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'heartbeat' })); }, 15000);
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.destination !== 'offscreen') return;
  const run = async () => {
    if (message.type === 'status') return sessions.counts();
    const entry = sessions.get(message.sessionId);
    if (message.type === 'approvedStart') return sessions.run(entry.sessionId, () => entry.recorder.command('start', message.options));
    if (message.type === 'enable') return sessions.run(entry.sessionId, () => entry.recorder.receive(message));
    return entry.recorder.receive(message);
  };
  run().then(respond).catch(error => respond({ error: error.message }));
  return true;
});
