import { beginCursorProbe } from './cursor-probe.js';
import { prepareCallout } from './callout.js';
import { sourceCrop, frameContentRect, recordingScale } from './frame-geometry.js';
import { layoutAnnotations, drawAnnotations } from './annotations.js';
import { drawPointer, needsPointerOverlay } from './pointer.js';
import { acquireMedia } from './capture-media.js';
import { settings } from './config.js';
import { visualChange } from './analysis.js';
const base = `http://127.0.0.1:${settings.port}`;
export function createRecorder(sessionId, background) {
let media, tab, video, recording, completed, source = 'tab', active = true;
const warnings = [];
function cropFrame(context, geometry) {
  const r = sourceCrop({ width: video.videoWidth, height: video.videoHeight }, geometry);
  context.drawImage(video, r.x, r.y, r.width, r.height, 0, 0, context.canvas.width, context.canvas.height);
}
function canvasFor(geometry, scale = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.ceil(geometry.region.width * scale / 2) * 2);
  canvas.height = Math.max(2, Math.ceil(geometry.region.height * scale / 2) * 2);
  return canvas;
}
function annotatedFrame(geometry, scale = 1) {
  const canvas = canvasFor(geometry, scale), ctx = canvas.getContext('2d');
  cropFrame(ctx, geometry);
  ctx.font = 'bold 14px sans-serif';
  const logical = { width: canvas.width / scale, height: canvas.height / scale };
  const annotations = layoutAnnotations(geometry, logical, text => ctx.measureText(text).width);
  const output = document.createElement('canvas'); output.width = canvas.width; output.height = annotations.height * scale;
  const annotated = output.getContext('2d');
  annotated.fillStyle = '#fff'; annotated.fillRect(0, 0, output.width, output.height);
  annotated.drawImage(canvas, 0, 0);
  annotated.scale(scale, scale);
  drawAnnotations(annotated, annotations, logical.width);
  const frame = { width: video.videoWidth, height: video.videoHeight };
  return { canvas: output, annotations, capture: { frame, content: frameContentRect(frame, geometry.viewport) } };
}
async function upload(kind, blob, metadata) {
  const encoded = new TextEncoder().encode(JSON.stringify({ ...metadata, sessionId }));
  const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, encoded.length);
  const payload = new Blob([prefix, encoded, blob], { type: 'application/octet-stream' });
  const response = await fetch(`${base}/upload?kind=${kind}`, { method: 'POST', headers: { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/octet-stream' }, body: payload });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not save capture.');
  return result;
}
function status() { return { sessionId, enabled: Boolean(media), tab, recording: Boolean(recording?.started), completed: Boolean(completed), cursor: media?.getVideoTracks()[0]?.getSettings().cursor, warnings }; }
function acceptCursorChunk(state, chunk) {
  if (!state.cursorCoverage || chunk?.captureId !== state.captureId) return;
  state.cursorCoverage.knownOverlay = true;
  let span = state.cursorCoverage.spans.find(item => item.from === chunk.from);
  if (!span) {
    span = { from: chunk.from, through: chunk.through, points: [] };
    state.cursorCoverage.spans.push(span);
  }
  span.through = Math.max(span.through, chunk.through);
  for (const point of chunk.points) {
    if (state.cursorPointCount >= 8000) break;
    span.points.push([point.at, point.x, point.y, point.opacity]);
    state.cursorPointCount++;
  }
}
const pageUnavailable = error => /Receiving end does not exist|Could not establish connection|No tab with id|No document with id|frame was removed|message port closed/i.test(error.message);
async function rearmCursor(state, documentId) {
  const previous = state.cursorRearm;
  const rearm = (async () => {
    await previous;
    if (state.stopping || recording !== state) return;
    try {
      const report = await background('cursorControl', { operation: 'start', captureId: state.captureId, trackPositions: true, documentId });
      state.cursorCoverage.knownOverlay ||= report.supported === true;
    } catch (error) {
      if (!pageUnavailable(error)) throw error;
    }
  })();
  state.cursorRearm = rearm.then(() => undefined, error => {
    state.warnings.push(`Could not restart cursor tracking after navigation: ${error.message}`);
  });
  await rearm;
}
function requireMedia() { if (!media) throw new Error('This session is not enabled. Check its approval status or request capture again.'); }
async function command(name, args = {}) {
  if (name === 'status') return status();
  if (name === 'release') {
    if (recording || completed) throw new Error('Finish and retrieve the recording with stop first.');
    media?.getTracks().forEach(track => track.stop());
    media = null; video = null; tab = null;
    return { released: true };
  }
  if (name === 'stop') {
    if (!recording && !completed) throw new Error('No recording to stop.');
    if (recording) await finish();
    const result = await upload('video', completed.blob, { ...completed.metadata, name: args.name });
    completed = null;
    return result;
  }
  requireMedia();
  if (name === 'include' || name === 'callout') {
    const state = recording;
    if (!state?.started || state.stopping) throw new Error('Start a recording before marking an element.');
    if (name === 'include' && state.includes.length >= 40) throw new Error('A clip can include at most 40 explicitly marked elements.');
    const geometry = await background('resolve', { highlight: [{ target: args.target, label: args.label, style: 'box' }] });
    if (recording !== state || state.stopping) throw new Error('The recording ended while resolving the target.');
    if (geometry.viewport.width !== state.geometry.viewport.width || geometry.viewport.height !== state.geometry.viewport.height) throw new Error('The viewport changed during recording. Start a new clip before marking an element.');
    if (name === 'include') {
      const rect = geometry.highlights[0].rect;
      state.includes.push({ rect, t: (Date.now() - state.started) / 1000 });
      return { sessionId, included: true, recording: true };
    }
    const snapshot = annotatedFrame(geometry, state.resolution.scale);
    const entry = prepareCallout(state, snapshot.canvas, { target: args.target, label: args.label, geometry, annotations: snapshot.annotations, annotationScale: state.resolution.scale }, args.holdSeconds);
    const blob = await new Promise(resolve => snapshot.canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not save the callout frame.');
    if (recording !== state || state.stopping) throw new Error('The recording ended while saving the callout.');
    const calloutId = crypto.randomUUID();
    state.callouts.push({ ...entry, calloutId, blob });
    return { sessionId, recording: true, calloutId, holdSeconds: args.holdSeconds, message: 'Callout saved. Continue immediately; the reading pause will be inserted when the clip is exported.' };
  }
  if (name === 'start' && (Object.hasOwn(args, 'region') || Object.hasOwn(args, 'padding'))) throw new Error('Video framing happens at export. Remove region and padding from capture_start.');
  const geometry = await background('resolve', name === 'start' ? {} : args);
  active = geometry.tabActive;
  if (name === 'screenshot') {
    const snapshot = annotatedFrame(geometry);
    return upload('screenshot', await new Promise(resolve => snapshot.canvas.toBlob(resolve, 'image/png')), { name: args.name, geometry, capture: snapshot.capture, annotations: snapshot.annotations, warnings: [...warnings] });
  }
  if (name !== 'start') throw new Error(`Unknown command: ${name}`);
  if (recording || completed) throw new Error('Retrieve the previous recording with stop first.');
  const chromeFrame = { width: video.videoWidth, height: video.videoHeight };
  const scale = recordingScale(args.resolution, chromeFrame, geometry.viewport);
  const canvas = canvasFor(geometry, scale), ctx = canvas.getContext('2d');
  const resolution = { requested: args.resolution ?? 'standard', scale, chromeFrame, recording: { width: canvas.width, height: canvas.height } };
  const sampleCanvas = document.createElement('canvas'); sampleCanvas.width = 160; sampleCanvas.height = 100;
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  cropFrame(ctx, geometry);
  const stream = canvas.captureStream(15);
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('WebM recording is unavailable in this browser.');
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5000000 });
  const animateCursor = args.animateCursor && !args.cursorOverlayProbe && !args.cursorProbe;
  const captureId = animateCursor ? crypto.randomUUID() : undefined;
  const cursorSuppression = (args.cursorOverlayProbe || animateCursor)
    ? await background('cursorControl', { operation: 'start', probePositions: args.cursorOverlayProbe === true, trackPositions: animateCursor, captureId })
    : undefined;
  if (cursorSuppression?.verified) await new Promise(resolve => setTimeout(resolve, 200));
  let cursorProbe;
  try {
    cursorProbe = args.cursorProbe ? await beginCursorProbe(media.getVideoTracks()[0], navigator.mediaDevices.getSupportedConstraints()) : undefined;
    cropFrame(ctx, geometry);
  } catch (error) {
    stream.getTracks().forEach(track => track.stop());
    await cursorProbe?.restore();
    if (cursorSuppression) await background('cursorControl', { operation: 'stop', captureId });
    throw error;
  }
  const encoderStartedAt = Date.now();
  const state = { recordingId: crypto.randomUUID(), resolution, cursorSuppression, cursorProbe, pointerSamples: [], canvas, ctx, stream, recorder, chunks: [], started: scale === 2 ? undefined : encoderStartedAt, geometry, args, events: [], samples: [], callouts: [], includes: [], previous: null, nextSample: 0, warnings: [...warnings] };
  if (animateCursor) {
    state.captureId = captureId;
    state.cursorCoverage = { source, knownOverlay: cursorSuppression?.supported === true, spans: [] };
    state.cursorPointCount = 0;
    const points = cursorSuppression?.tracking?.points;
    if (cursorSuppression?.safeForAnimation && points?.length) {
      const { at } = points[0];
      acceptCursorChunk(state, { captureId, from: cursorSuppression.from ?? at, through: at, points });
    }
  }
  recording = state;
  recorder.ondataavailable = event => { if (event.data.size) state.chunks.push(event.data); };
  state.done = new Promise((resolve, reject) => {
    recorder.onstop = resolve;
    recorder.onerror = event => reject(event.error || new Error('MediaRecorder failed'));
  });
  try { recorder.start(1000); }
  catch (error) {
    recording = null;
    stream.getTracks().forEach(track => track.stop());
    await state.cursorProbe?.restore();
    if (cursorSuppression) await background('cursorControl', { operation: 'stop', captureId });
    throw error;
  }
  state.timer = setInterval(() => {
    cropFrame(ctx, state.frameGeometry ?? geometry);
    if (!state.started) return;
    const t = (Date.now() - state.started) / 1000;
    if (t >= state.nextSample) {
      sampleCtx.drawImage(canvas, 0, 0, 160, 100);
      const current = sampleCtx.getImageData(0, 0, 160, 100).data;
      state.samples.push({ t, changed: visualChange(state.previous, current) });
      state.previous = current; state.nextSample = t + 0.2;
    }
    for (const event of animateCursor ? state.events.filter(event => event.type === 'click') : state.events) {
      if (!['pointerdown', 'click'].includes(event.type) || t - event.t < 0 || t - event.t > 0.45) continue;
      const x = (event.x - geometry.region.x) * canvas.width / geometry.region.width;
      const y = (event.y - geometry.region.y) * canvas.height / geometry.region.height;
      ctx.strokeStyle = '#ef233c'; ctx.lineWidth = 2 * scale;
      ctx.globalAlpha = 1 - (t - event.t) / 0.45;
      ctx.beginPath(); ctx.arc(x, y, (22 + (t - event.t) * 18) * scale, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (!state.cursorSuppression && !state.cursorProbe && state.pointer && needsPointerOverlay(source, active)) drawPointer(ctx, state.pointer, geometry, scale);
  }, 1000 / 15);
  if (scale === 2) {
    try {
      await Promise.race([new Promise(resolve => setTimeout(resolve, 1000)), state.done]);
      if (state.stopping || recorder.state === 'inactive') throw new Error('Recording ended during encoder warm-up.');
    } catch (error) {
      await finish();
      throw error;
    }
    state.started = Date.now();
    state.warmupSeconds = (state.started - encoderStartedAt) / 1000;
    geometry.tabActive = active;
  }
  state.limit = setTimeout(() => finish().catch(error => { warnings.push(error.message); throw error; }), args.maxSeconds * 1000);
  return { sessionId, recording: true, framing: args.framing, resolution, viewport: geometry.viewport, maxSeconds: args.maxSeconds, preserveTiming: args.preserveTiming, cursorProbe: cursorProbe?.report, cursorSuppression };
}
function finish() {
  const state = recording;
  if (state) return state.finishPromise ??= finishRecording(state);
}
async function finishRecording(state) {
  state.stopping = true;
  const ended = Date.now();
  clearInterval(state.timer); clearTimeout(state.limit);
  if (state.recorder.state !== 'inactive') state.recorder.stop();
  try { await state.done; }
  finally {
    try { await restoreCapture(state); }
    finally { recording = null; }
  }
  if (!state.started) return;
  const videoBlob = new Blob(state.chunks, { type: state.recorder.mimeType });
  const calloutBlobs = state.callouts.map(callout => callout.blob);
  completed = { blob: new Blob([videoBlob, ...calloutBlobs]), metadata: { recordingId: state.recordingId, resolution: state.resolution, warmupSeconds: state.warmupSeconds, framing: state.args.framing ?? 'auto', viewportChanged: Boolean(state.frameGeometry), videoBytes: videoBlob.size, calloutSizes: calloutBlobs.map(blob => blob.size), includes: state.includes, captureStartedAt: state.started, animateCursor: state.args.animateCursor === true && !state.args.cursorOverlayProbe && !state.args.cursorProbe, cursorSuppression: state.cursorSuppression, cursorCoverage: state.cursorCoverage, cursorProbe: state.cursorProbe?.report, pointerSamples: state.cursorProbe || state.cursorSuppression ? state.pointerSamples : undefined, geometry: state.geometry, duration: (ended - state.started) / 1000, events: state.events, samples: state.samples, callouts: state.callouts.map(({ blob: _, ...callout }) => callout), preserveTiming: state.args.preserveTiming, pointerRendering: state.cursorCoverage ? 'per-interval-at-export' : state.cursorSuppression ? 'source-only-overlay-suppression-probe' : state.cursorProbe ? 'source-only-cursor-suppression-probe' : source === 'display' ? 'reconstructed-from-page-events' : 'native-with-background-fallback', warnings: state.warnings } };
}
async function restoreCapture(state) {
  await state.cursorRearm;
  state.stream.getTracks().forEach(track => track.stop());
  await state.cursorProbe?.restore();
  if (state.cursorSuppression) {
    try { state.cursorSuppression = await background('cursorControl', { operation: 'stop', captureId: state.captureId }); }
    catch (error) {
      if (!pageUnavailable(error)) throw error;
      state.cursorSuppression = { requested: true, safeForAnimation: false, lost: true, error: error.message };
    }
    if (state.cursorCoverage) {
      acceptCursorChunk(state, state.cursorSuppression.chunk);
      delete state.cursorSuppression.chunk;
      if (state.cursorSuppression.tracking) delete state.cursorSuppression.tracking.points;
    }
    if (!state.cursorCoverage && !state.cursorSuppression.safeForAnimation && state.cursorSuppression.tracking?.valid !== false) state.warnings.push('Cursor suppression could not be verified throughout this clip; do not add an animated pointer.');
  }
}

async function receive(message) {
    if (message.type === 'cursorNewDocument') {
      if (recording?.cursorCoverage && !recording.stopping) await rearmCursor(recording, message.documentId);
      return;
    }
    if (message.type === 'cursorChunk') {
      if (recording) acceptCursorChunk(recording, message.chunk);
      return;
    }
    if (message.type === 'tabActivity') { active = message.active; if (recording?.started && recording.cursorSuppression) recording.events.push({ type: 'tabActivity', active, t: (Date.now() - recording.started) / 1000 }); return; }
    if (message.type === 'event') {
      if (recording && !recording.stopping) {
        const event = { ...message.event, t: (message.event.at - recording.started) / 1000 };
        if (event.type === 'viewportResize') {
          const { width, height } = event.viewport;
          if (width !== recording.geometry.viewport.width || height !== recording.geometry.viewport.height || recording.frameGeometry) {
            recording.frameGeometry = { viewport: event.viewport, region: { x: 0, y: 0, width, height } };
          }
          return;
        }
        if (!recording.started || event.t < 0) return;
        if (event.type === 'pointerdown') recording.dragOrigin = event;
        if (event.type === 'pointerup') {
          const origin = recording.dragOrigin;
          recording.dragOrigin = undefined;
          if (origin && Math.hypot(event.x - origin.x, event.y - origin.y) > 8) recording.events.push({ ...event, type: 'dragEnd' });
        }
        if (['pointermove', 'pointerdown', 'pointerup'].includes(event.type)) {
          recording.pointer = event;
          if (recording.cursorProbe || recording.cursorSuppression) recording.pointerSamples.push({ t: event.t, x: event.x, y: event.y, type: event.type, buttons: event.buttons, tabActive: active });
        }
        if (['pointermove', 'pointerup'].includes(event.type)) return;
        const last = recording.events.at(-1);
        if (event.type !== 'scroll' || !last || event.t - last.t > 0.15) recording.events.push(event);
      }
      return;
    }
    if (message.type === 'warning') { warnings.push(message.message); return; }
    if (message.type === 'enable') {
      if (media) throw new Error('This session is already enabled.');
      const candidate = await acquireMedia(navigator.mediaDevices, message);
      source = message.source || 'tab';
      media = candidate;
      tab = message.tab;
      video = document.createElement('video'); video.muted = true; video.srcObject = media;
      try { await video.play(); }
      catch (error) { candidate.getTracks().forEach(track => track.stop()); media = null; video = null; throw error; }
      media.getVideoTracks()[0].onended = () => {
        media = null;
        warnings.push('Tab capture ended. Re-enable the tab to continue.');
        if (recording) finish().catch(error => { warnings.push(error.message); throw error; });
      };
      return status();
    }
}
return { command, receive, status };
}
