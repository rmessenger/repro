import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, copyFile, stat, rm } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { layoutAnnotations, drawAnnotations } from '../extension/annotations.js';
import { processVideo, run } from './process.js';
import { visualChange } from './timeline.js';

async function inputFile(file) {
  if (!path.isAbsolute(file)) throw new Error('Supply an absolute local file path from the browser tool.');
  if (!(await stat(file)).isFile()) throw new Error('The input must be a local file.');
  return file;
}

async function artifact(root) {
  const directory = path.join(root, randomUUID());
  await mkdir(directory, { recursive: true });
  return directory;
}

function geometryFor(size, options) {
  const viewport = options.viewport || { width: size.width, height: size.height };
  const region = options.region || { x: 0, y: 0, ...viewport };
  if (region.x + region.width > viewport.width + 0.01 || region.y + region.height > viewport.height + 0.01) throw new Error('The crop must fit inside the viewport.');
  if (region.width < 2 || region.height < 2 || viewport.width > 16384 || viewport.height > 16384 || viewport.width * viewport.height > 40000000) throw new Error('Viewport or crop dimensions are unsupported.');
  if (Math.abs(size.width / size.height - viewport.width / viewport.height) > 0.02) throw new Error('Viewport aspect ratio does not match the source. Use the dimensions of the recorded viewport.');
  return { viewport, region, highlights: (options.highlight || []).map(h => ({ ...h, rect: h.target })) };
}

function pixelCrop(size, { region, viewport }) {
  const horizontal = size.width / viewport.width, vertical = size.height / viewport.height;
  const x = Math.round(region.x * horizontal), y = Math.round(region.y * vertical);
  const right = Math.min(size.width, Math.round((region.x + region.width) * horizontal));
  const bottom = Math.min(size.height, Math.round((region.y + region.height) * vertical));
  const width = right - x, height = bottom - y;
  if (width < 1 || height < 1) throw new Error('The crop must cover at least one source pixel in each direction.');
  return { x, y, width, height, scaleX: width / region.width, scaleY: height / region.height };
}

async function renderImage(image, geometry, crop, outputPath, padding = { right: 0, bottom: 0 }) {
  const { width, height } = geometry.region;
  const measure = createCanvas(1, 1).getContext('2d');
  measure.font = 'bold 14px sans-serif';
  const annotations = layoutAnnotations(geometry, { width, height }, text => measure.measureText(text).width);
  const legendHeight = Math.ceil((annotations.height - height) * crop.scaleY);
  const output = createCanvas(crop.width + padding.right, crop.height + padding.bottom + legendHeight);
  const ctx = output.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, output.width, output.height);
  ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  ctx.scale(crop.scaleX, crop.scaleY);
  drawAnnotations(ctx, annotations, width);
  await writeFile(outputPath, await output.encode('png'));
  return annotations;
}

export async function annotateFile(options, root) {
  const imagePath = await inputFile(options.imagePath);
  const image = await loadImage(imagePath);
  const geometry = geometryFor(image, options);
  const crop = pixelCrop(image, geometry);
  const directory = await artifact(root);
  const screenshot = path.join(directory, 'screenshot.png');
  const annotations = await renderImage(image, geometry, crop, screenshot);
  const manifest = path.join(directory, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ source: imagePath, geometry, annotations }, null, 2));
  return { screenshot, manifest, region: geometry.region, annotations };
}

async function sampleVideo(file, directory, filter) {
  const samplesPath = path.join(directory, 'samples.rgba');
  await run('ffmpeg', ['-v', 'error', '-i', file, '-vf', `${filter},fps=5,scale=80:50,format=rgba`, '-f', 'rawvideo', samplesPath]);
  const frames = await readFile(samplesPath), bytes = 80 * 50 * 4;
  const samples = []; let previous;
  for (let i = 0; i + bytes <= frames.length; i += bytes) {
    const current = frames.subarray(i, i + bytes);
    samples.push({ t: i / bytes / 5, changed: visualChange(previous, current) });
    previous = current;
  }
  await rm(samplesPath);
  return samples;
}

async function prepareVideo(original, directory, filter, events, region, crop) {
  const clicks = events.filter(e => ['pointerdown', 'click'].includes(e.type) && Number.isFinite(e.x) && Number.isFinite(e.y));
  const prepared = path.join(directory, 'prepared.mp4');
  const args = ['-v', 'error', '-i', original];
  const filters = [`[0:v]${filter}[base0]`];
  if (clicks.length) {
    const ring = createCanvas(Math.max(1, Math.round(48 * crop.scaleX)), Math.max(1, Math.round(48 * crop.scaleY)));
    const ctx = ring.getContext('2d');
    ctx.scale(ring.width / 48, ring.height / 48);
    ctx.strokeStyle = '#ef233c'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(24, 24, 21, 0, Math.PI * 2); ctx.stroke();
    const ringPath = path.join(directory, 'click.png');
    await writeFile(ringPath, await ring.encode('png'));
    args.push('-loop', '1', '-i', ringPath);
    filters.push(`[1:v]split=${clicks.length}${clicks.map((_, i) => `[ring${i}]`).join('')}`);
    clicks.forEach((event, i) => {
      const x = (event.x - region.x) * crop.scaleX - ring.width / 2;
      const y = (event.y - region.y) * crop.scaleY - ring.height / 2;
      filters.push(`[base${i}][ring${i}]overlay=x=${x}:y=${y}:enable='gte(t,${event.t})*lt(t,${event.t + 0.45})':shortest=1[base${i + 1}]`);
    });
  }
  args.push('-filter_complex', filters.join(';'), '-map', `[base${clicks.length}]`, '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', prepared);
  await run('ffmpeg', args);
  return prepared;
}

export async function exportFile(options, root) {
  const videoPath = await inputFile(options.videoPath);
  const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', videoPath]));
  const stream = probe.streams.find(s => s.codec_type === 'video');
  const duration = Number(probe.format.duration);
  if (!stream || !Number.isFinite(duration) || duration <= 0 || duration > 180) throw new Error('Supply a video with a known duration of up to 180 seconds.');
  if (options.events.some(e => e.t >= duration) || options.callouts.some(c => c.at >= duration)) throw new Error('Event and callout timestamps must fall inside the source recording.');
  const geometry = geometryFor(stream, options);
  const crop = pixelCrop(stream, geometry);
  const padding = { right: crop.width % 2, bottom: crop.height % 2 };
  const { region } = geometry;
  const directory = await artifact(root), sessionId = path.basename(directory);
  const extension = ['.mp4', '.webm', '.mov', '.mkv'].includes(path.extname(videoPath).toLowerCase()) ? path.extname(videoPath).toLowerCase() : '.video';
  const original = path.join(directory, `original${extension}`);
  await copyFile(videoPath, original);
  // Subsampled chroma rounds odd edges during padding, replacing the last content pixels.
  const cropFormat = [crop.x, crop.y, crop.width, crop.height].some(pixels => pixels % 2) ? 'format=yuv444p,' : '';
  const filter = `${cropFormat}crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}:exact=1,pad=${crop.width + padding.right}:${crop.height + padding.bottom}:0:0:white,setsar=1`;
  const samples = options.preserveTiming ? [] : await sampleVideo(original, directory, filter);
  const callouts = [];
  for (const callout of options.callouts) {
    const imageDirectory = await artifact(directory), frame = path.join(imageDirectory, 'frame.png');
    await run('ffmpeg', ['-v', 'error', '-i', original, '-ss', String(callout.at), '-frames:v', '1', frame]);
    const calloutGeometry = { ...geometry, highlights: callout.highlight.map(h => ({ ...h, rect: h.target })) };
    const annotations = await renderImage(await loadImage(frame), calloutGeometry, crop, path.join(imageDirectory, 'screenshot.png'), padding);
    await writeFile(path.join(imageDirectory, 'manifest.json'), JSON.stringify({ sessionId, geometry: calloutGeometry, annotations }, null, 2));
    callouts.push({ at: callout.at, holdSeconds: callout.holdSeconds, calloutId: path.basename(imageDirectory), mode: 'inserted-freeze-frame', annotations });
  }
  const prepared = await prepareVideo(original, directory, filter, options.events, region, crop);
  const keyboardFrame = { width: region.width, height: region.height, scaleX: crop.scaleX, scaleY: crop.scaleY };
  const result = await processVideo(directory, { sessionId, source: 'local-browser-file', sourcePath: videoPath, geometry, duration, samples, events: options.events, callouts, warnings: [], preserveTiming: options.preserveTiming }, { calloutRoot: directory, inputPath: prepared, originalPath: original, keyboardFrame });
  return { ...result, screenshots: callouts.map(c => path.join(directory, c.calloutId, 'screenshot.png')) };
}
