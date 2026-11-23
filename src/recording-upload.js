import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { processVideo, videoResult } from './process.js';

export function recordingParts(metadata, bytes) {
  const { recordingId, framing, videoBytes, calloutSizes, callouts } = metadata;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recordingId || '') || !['auto', 'viewport'].includes(framing)) throw new Error('Invalid recording identity or framing mode.');
  if (!Array.isArray(calloutSizes) || !Array.isArray(callouts) || calloutSizes.length > 20 || calloutSizes.length !== callouts.length) throw new Error('Invalid callout bundle.');
  const lengths = [videoBytes, ...calloutSizes];
  if (lengths.some(size => !Number.isSafeInteger(size) || size <= 0) || lengths.reduce((total, size) => total + size, 0) !== bytes.length) throw new Error('Invalid recording payload lengths.');
  let offset = 0;
  return lengths.map(size => { const segment = bytes.subarray(offset, offset + size); offset += size; return segment; });
}

async function readJsonIfPresent(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function saveRecording(directory, metadata, [video, ...callouts]) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const raw = path.join(directory, 'original.webm');
  const calloutFiles = callouts.map((_, index) => path.join(directory, `source-callout-${index + 1}.png`));
  const capture = path.join(directory, 'capture.json');
  const manifest = await readJsonIfPresent(path.join(directory, 'manifest.json'));
  const existing = manifest ?? await readJsonIfPresent(capture);
  if (existing && (existing.recordingId !== metadata.recordingId || existing.sessionId !== metadata.sessionId)) throw new Error('This recording belongs to another capture.');
  let result;
  if (manifest) result = videoResult(manifest);
  else {
    const options = { mode: 0o600 };
    await writeFile(raw, video, options);
    await Promise.all(calloutFiles.map((file, index) => writeFile(file, callouts[index], options)));
    await writeFile(capture, JSON.stringify(metadata, null, 2), options);
    try { result = await processVideo(directory, metadata); }
    catch (error) { throw new Error(`Export failed. The temporary source is at ${directory}. Retry capture_stop with the same session. ${error.message}`, { cause: error }); }
  }
  await Promise.all([raw, capture, ...calloutFiles].map(file => rm(file, { force: true })));
  return result;
}
