import { selectCursorSource } from './cursor-source.js';
import { cursorEnabled, planCursorHolds, planCursor, cursorExpressions, cursorSvg, ringSvg, cursorFrameRate } from './cursor.js';
import sharp from 'sharp';
import { planEditing, planEditingOverlays, fieldRectangle, editingSvg } from './editing.js';
import { planKeyboardBadges, keyboardBadgeSvg } from './keyboard.js';
import { spawn } from 'node:child_process';
import { writeFile, readFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { planTimeline } from './timeline.js';
import { planPlayback, frameRate } from './playback.js';
export function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${binary} exited ${code}: ${stderr}`)));
  });
}
export async function processVideo(directory, metadata, { calloutRoot = path.dirname(directory), inputPath = path.join(directory, 'original.webm'), originalPath = inputPath, keyboardFrame } = {}) {
  metadata = selectCursorSource(metadata);
  const raw = inputPath;
  const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', raw]));
  const stream = probe.streams.find(s => s.codec_type === 'video');
  const probed = Number(probe.format.duration);
  const duration = Number.isFinite(probed) ? Math.min(probed, metadata.duration) : metadata.duration;
  const timeline = planTimeline(duration, metadata.samples, cursorEnabled(metadata) ? [...metadata.events, ...(metadata.pointerSamples || [])] : metadata.events, metadata.preserveTiming, metadata.callouts);
  const callouts = metadata.callouts || [];
  if (callouts.length > 20) throw new Error('A clip can contain at most 20 callouts.');
  const editing = planEditing(metadata.events, timeline, callouts, duration, metadata.preserveTiming);
  editing.holds = editing.holds.filter(hold => fieldRectangle(hold.field.rect, metadata.geometry, stream));
  const basePlayback = planPlayback(timeline, callouts, duration, editing.holds);
  const cursorTiming = planCursorHolds(metadata, basePlayback);
  const playback = planPlayback(timeline, callouts, duration, editing.holds, cursorTiming.holds);
  const cursor = planCursor(metadata, playback, metadata.geometry, stream, cursorTiming.holds);
  editing.overlays = planEditingOverlays(editing, playback, metadata.geometry, stream);
  const args = ['-y', '-v', 'error', '-i', raw];
  for (const [index, callout] of callouts.entries()) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(callout.calloutId || '')) throw new Error('Invalid callout image ID.');
    const imageDirectory = path.join(calloutRoot, callout.calloutId);
    const imageMetadata = JSON.parse(await readFile(path.join(imageDirectory, 'manifest.json'), 'utf8'));
    if (!metadata.sessionId || imageMetadata.sessionId !== metadata.sessionId) throw new Error('The callout image belongs to another capture session.');
    const image = path.join(directory, `callout-${index + 1}.png`);
    await copyFile(path.join(imageDirectory, 'screenshot.png'), image);
    args.push('-loop', '1', '-framerate', String(frameRate), '-i', image);
  }
  const keyboard = planKeyboardBadges(metadata.events, playback, keyboardFrame ?? stream);
  const { scaleX, scaleY } = keyboardFrame ?? { scaleX: 1, scaleY: 1 };
  const even = pixels => Math.ceil(Math.round(pixels) / 2) * 2;
  const video = {
    width: Math.max(stream.width, even(keyboard.width * scaleX)),
    height: Math.max(stream.height, even(keyboard.height * scaleY)),
  };
  for (const [index, badge] of keyboard.badges.entries()) {
    const file = path.join(directory, `keys-${index + 1}.png`);
    const density = Math.ceil(72 * Math.max(1, scaleX, scaleY));
    await sharp(Buffer.from(keyboardBadgeSvg(badge)), { density })
      .resize(Math.max(1, Math.round(badge.width * scaleX)), Math.max(1, Math.round(badge.height * scaleY)), { fit: 'fill' })
      .png().toFile(file);
    args.push('-loop', '1', '-framerate', String(frameRate), '-i', file);
  }
  const editImages = [];
  for (const overlay of editing.overlays) {
    const key = JSON.stringify([overlay.rect, overlay.label]);
    let index = editImages.findIndex(image => image.key === key);
    if (index < 0) {
      index = editImages.length;
      const file = path.join(directory, `editing-${index + 1}.png`);
      await sharp(Buffer.from(editingSvg(overlay.rect, overlay.label, stream))).png().toFile(file);
      editImages.push({ key, file });
      args.push('-loop', '1', '-framerate', String(frameRate), '-i', file);
    }
    overlay.imageIndex = index;
  }
  const cursorInput = 1 + callouts.length + keyboard.badges.length + editImages.length;
  if (cursor.enabled) {
    const file = path.join(directory, 'cursor.png');
    await sharp(Buffer.from(cursorSvg)).png().toFile(file);
    args.push('-loop', '1', '-framerate', String(frameRate), '-i', file);
    const ringFile = path.join(directory, 'cursor-rings.png');
    await sharp(Buffer.from(ringSvg)).png().toFile(ringFile);
    args.push('-loop', '1', '-framerate', String(cursorFrameRate), '-i', ringFile);
  }
  const filters = playback.map((segment, index) => segment.type === 'video'
    ? `[0:v]fps=${frameRate},trim=start_frame=${segment.startFrame}:end_frame=${segment.endFrame},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[out${index}]`
    : ['autoHold', 'cursorHold'].includes(segment.type)
      ? `[0:v]fps=${frameRate},trim=start_frame=${segment.sourceFrame}:end_frame=${segment.sourceFrame + 1},setpts=PTS-STARTPTS,loop=loop=${segment.frames - 1}:size=1:start=0,trim=end_frame=${segment.frames},setpts=N/(${frameRate}*TB),setsar=1,format=yuv420p[out${index}]`
    : `[${segment.calloutIndex + 1}:v]scale=${stream.width}:${stream.height}:force_original_aspect_ratio=decrease,pad=${stream.width}:${stream.height}:(ow-iw)/2:(oh-ih)/2:color=white,trim=end_frame=${segment.frames},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[out${index}]`);
  const keyboardTailSeconds = Math.max(0, keyboard.end - (playback.at(-1)?.outputEnd || 0));
  filters.push(`${playback.map((_, i) => `[out${i}]`).join('')}concat=n=${playback.length}:v=1:a=0,format=yuv420p[editbase0]`);
  editImages.forEach((_, index) => {
    const enabled = editing.overlays.filter(overlay => overlay.imageIndex === index).map(overlay => `gte(t,${overlay.start})*lt(t,${overlay.end})`).join('+');
    filters.push(`[editbase${index}][${callouts.length + keyboard.badges.length + index + 1}:v]overlay=0:0:shortest=1:enable='${enabled}'[editbase${index + 1}]`);
  });
  let cursorBase = `editbase${editImages.length}`;
  if (cursor.enabled) {
    const expressions = cursorExpressions(cursor);
    filters.push(`[${cursorBase}]fps=${cursorFrameRate}[cursorbase]`);
    filters.push(`[${cursorInput + 1}:v]crop=w=64:h=64:x='${expressions.ringFrame}':y=0[ring]`);
    filters.push(`[cursorbase][ring]overlay=x='${expressions.ringX}':y='${expressions.ringY}':eval=frame:format=auto:shortest=1[ringbase]`);
    filters.push(`[ringbase][${cursorInput}:v]overlay=x='${expressions.x}':y='${expressions.y}':eval=frame:format=auto:shortest=1[cursorvideo]`);
    cursorBase = 'cursorvideo';
  }
  // concat drops the frame rate, which tpad needs to extend the final frame.
  const tailRate = keyboardTailSeconds ? `fps=${cursor.enabled ? cursorFrameRate : frameRate},` : '';
  filters.push(`[${cursorBase}]${tailRate}tpad=stop_mode=clone:stop_duration=${keyboardTailSeconds},pad=${video.width}:${video.height}:(ow-iw)/2:0:color=white[keybase0]`);
  keyboard.badges.forEach((badge, index) => filters.push(`[keybase${index}][${callouts.length + index + 1}:v]overlay=x=W-w-${8 * scaleX}:y=H-h-${8 * scaleY}:shortest=1:enable='gte(t,${badge.start})*lt(t,${badge.end})'[keybase${index + 1}]`));
  filters.push(`[keybase${keyboard.badges.length}]format=yuv420p[final]`);
  const output = path.join(directory, 'clip.mp4');
  const filterFile = path.join(directory, 'export-filters.txt');
  await writeFile(filterFile, filters.join(';'));
  args.push('-filter_complex_script', filterFile, '-map', '[final]', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-movflags', '+faststart', output);
  await run('ffmpeg', args);
  const keptSeconds = timeline.reduce((sum, segment) => sum + segment.end - segment.start, 0);
  const insertedSeconds = playback.filter(segment => segment.type !== 'video').reduce((sum, segment) => sum + segment.frames / frameRate, 0);
  const automaticHoldSeconds = playback.filter(segment => segment.type === 'autoHold').reduce((sum, segment) => sum + segment.frames / frameRate, 0);
  const warnings = [...(metadata.warnings || []), ...editing.warnings, ...cursorTiming.warnings];
  const outputDurationSeconds = Number(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', output]));
  const cursorHoldSeconds = playback.filter(segment => segment.type === 'cursorHold').reduce((sum, segment) => sum + segment.frames / frameRate, 0);
  const manifest = { ...metadata, duration, timeline, playback, cursor: { ...cursor, holds: cursorTiming.holds }, cursorHoldSeconds, editing, warnings, automaticHoldSeconds, keyboard, keyboardTailSeconds, keptSeconds, insertedSeconds, outputDurationSeconds, omittedSeconds: duration - keptSeconds, sourceVideo: { width: stream.width, height: stream.height }, video, original: originalPath, clip: output };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { clip: output, original: originalPath, manifest: path.join(directory, 'manifest.json'), durationSeconds: duration, keptSeconds, insertedSeconds, outputDurationSeconds, calloutCount: callouts.length, keyboardTailSeconds, omittedSeconds: duration - keptSeconds, clickCount: metadata.events.filter(e => ['pointerdown', 'click'].includes(e.type)).length, automaticHoldSeconds, cursorHoldSeconds, warnings };
}
