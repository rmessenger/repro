import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { schemas, descriptions, recordingGuidance } from './schema.js';
import { readFile } from 'node:fs/promises';
export const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const chromeInstructions = 'Use Repro to save cropped screenshots, annotated PNGs, and short screen recordings while testing or demonstrating websites with your existing Chrome browser controls. It adds click indicators and trims idle time automatically. Use capture_status for readiness and installation help. New tabs need one user REC click; reuse approved sessionId handles across clips. Sessions are independent across tabs. Do not record until the user approves. Approval comes directly from Chrome: immediately call capture_wait with seconds:50 after a pending capture_start. Do not ask the user to confirm approval in chat or use a question/confirmation dialog; the toolbar click is the only required user action. Resume automatically when recording is true. After a full 50-second wait still awaiting approval, optionally give a brief non-blocking reminder to click REC, then wait again. Queued requests should wait quietly for their turn.\nChoose a region by testId, role/name, unique visible text, CSS selector, rectangle, or a union of targets; use highlight boxes/arrows for screenshots. This server records evidence; continue navigation and interactions through your existing Chrome tools. Call capture_wait with sessionId and requestId until recording is true. At important findings, call capture_callout with sessionId, target and label to insert a red-boxed freeze-frame with 3 seconds of reading time in the exported video. The tool saves the frame and returns immediately; continue browser actions without waiting for the hold duration. Retrieve videos with capture_stop; keep approved sessions enabled between testing sessions. For a screenshot on a new tab, first start and approve a session, stop the initial clip, then capture_screenshot. Do not build custom screenshot/video editing scripts for supported crops or annotations. If the extension is disconnected, relay the supplied setup instructions and wait for the user; do not attempt to bypass Chrome installation or capture approval.\n' + recordingGuidance;
export const instructions = [
  'Use the capture method the user requests. A request for the current task takes precedence over a standing preference. If their preferred method is unavailable, explain what is needed and ask before switching. With no preference, use the current browser’s built-in capture if it can save the requested media to files Repro can access. Otherwise, use the Repro Chrome extension.',
  'For saved browser captures, use capture_annotate for screenshots and capture_export for recordings. Use the browser’s controls to capture media, interact, and measure element rectangles. Pass absolute file paths and viewport CSS dimensions. If the browser provides a recording start timestamp and JavaScript evaluation, optionally call capture_browser_script with startedAt and evaluate its installExpression. Read events before stopping, then evaluate cleanupExpression. Supply actual interaction timestamps for click and shortcut indicators. Do not log ordinary typed text. Callout timestamps are seconds from the start of the source recording. The exporter extracts source frames, draws annotations, inserts reading pauses, and trims idle time. Keep the original and manifest for timing evidence.',
  'Chrome extension workflow. Use a Chrome tab and follow the extension’s approval flow.',
  chromeInstructions,
].join('\n\n');
export function createMcpServer(execute, connectionHelp = '') {
  const server = new McpServer({ name: 'repro', title: 'Repro — screenshots and recordings', version }, { instructions: `${instructions}\n${connectionHelp}`.trim() });
  for (const [name, schema] of Object.entries(schemas)) {
    server.registerTool(`capture_${name}`, {
      title: ({ browser_script: 'Prepare browser input timestamps', annotate: 'Annotate a saved browser screenshot', export: 'Export a saved browser recording', status: 'Check Chrome capture readiness', start: 'Record cropped Chrome video', callout: 'Highlight and hold a recording frame', wait: 'Wait for capture approval', stop: 'Save recorded Chrome video', screenshot: 'Save annotated Chrome screenshot', release: 'Release Chrome capture session' })[name],
      description: descriptions[name], inputSchema: schema.shape,
      annotations: { readOnlyHint: ['status', 'wait', 'browser_script'].includes(name), destructiveHint: false, openWorldHint: false },
    }, async args => {
      try {
        const parsed = schema.parse(args);
        const result = await execute(name, parsed);
        return { content: [{ type: 'text', text: JSON.stringify(withApprovalGuidance(name, parsed, result)) }] };
      }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
  }
  return server;
}

export function withApprovalGuidance(name, args, result) {
  if (!['start', 'wait'].includes(name)) return result;
  if (result.recording) return { ...result, agentNextStep: 'Recording is active. Continue browser interactions now; do not wait for a chat reply or ask for confirmation. ' + recordingGuidance };
  const approval = result.approval || result;
  if (!['queued', 'awaiting_approval', 'starting'].includes(approval.state)) return result;
  const reminder = name === 'wait' && args.seconds >= 50 && approval.state === 'awaiting_approval';
  return { ...result, agentNextStep: {
    tool: 'capture_wait',
    arguments: { sessionId: result.sessionId, requestId: approval.requestId, seconds: 50 },
    instruction: `${reminder ? 'A full wait ended without approval. You may give a brief non-blocking reminder to click REC, then wait again.' : 'Wait automatically for the Chrome approval signal; no reminder is needed yet.'} Do not ask for a chat reply, use a question/confirmation dialog, or stop to await an acknowledgement. The user only needs to click the extension. Continue immediately when recording is true.`,
  } };
}
