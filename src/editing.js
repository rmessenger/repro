import { frameRate } from './playback.js';
const edits = new Set(['beforeinput', 'paste']);
const clicks = new Set(['pointerdown', 'click']);
const validField = field => field && Number.isFinite(field.id) && field.rect && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(field.rect[k])) && field.rect.width > 0 && field.rect.height > 0;
const overlap = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));

export function editingBursts(events, duration) {
  const ordered = events.filter(e => Number.isFinite(e.t) && e.t >= 0 && e.t < duration).sort((a, b) => a.t - b.t);
  const bursts = []; let intent, interaction;
  for (const event of ordered) {
    if (clicks.has(event.type) && !validField(event.field)) interaction = event;
    if (edits.has(event.type) && validField(event.field)) intent = event;
    if (event.type === 'editlayout' && validField(event.field)) {
      const current = bursts.at(-1);
      if (current?.field.id === event.field.id && event.t - current.end < 0.3) current.positions.push({ t: event.t, rect: event.field.rect });
    }
    if (event.type !== 'input' || !validField(event.field)) continue;
    let burst = bursts.at(-1);
    const interrupted = interaction && interaction.t > (burst?.end ?? -1) && interaction.field?.id !== event.field.id;
    const pre = intent?.field.id === event.field.id && event.t - intent.t < 0.3 ? intent : event;
    if (!burst || burst.field.id !== event.field.id || event.t - burst.end > 1.2 || interrupted) {
      burst = { start: pre.t, end: event.t, field: pre.field, interaction: interaction && interaction.t <= pre.t ? interaction : undefined, positions: [] };
      bursts.push(burst);
    }
    burst.end = event.t;
    burst.positions.push({ t: event.t, rect: event.field.rect });
    intent = undefined;
  }
  for (const burst of bursts) {
    const blur = ordered.find(event => event.t > burst.start && ['pointerdown', 'focusin'].includes(event.type) && event.field?.id !== burst.field.id);
    burst.blurAt = blur?.t;
  }
  return bursts;
}
export function planEditing(events, timeline, callouts, duration, preserveTiming = false) {
  const bursts = editingBursts(events, duration), holds = [], warnings = [];
  for (const [index, burst] of bursts.entries()) {
    const previous = bursts[index - 1];
    const interaction = burst.interaction;
    const selected = interaction && interaction.field?.id !== burst.field.id && interaction.t >= (previous?.end ?? 0);
    const contextStart = Math.max(previous?.end ?? 0, selected ? interaction.t : 0);
    const minimum = selected || !previous ? 0.8 : 0.5;
    const visible = timeline.reduce((sum, w) => sum + overlap(contextStart, burst.start, w.start, w.end), 0);
    const manual = callouts.filter(c => c.at >= contextStart && c.at <= burst.start).reduce((sum, c) => sum + c.holdSeconds, 0);
    const missing = minimum - visible - manual;
    if (preserveTiming || missing <= 1 / frameRate) continue;
    // Use a real frame before the edit, allowing one frame after the preceding action.
    const sourceFrame = Math.floor(burst.start * frameRate) - 1;
    if (sourceFrame < 0 || sourceFrame / frameRate < contextStart + 1 / frameRate) {
      warnings.push(`No distinct pre-edit frame for field ${burst.field.id} at ${burst.start.toFixed(3)}s; automatic hold skipped.`);
      continue;
    }
    holds.push({ at: burst.start, sourceFrame, holdSeconds: Math.ceil(missing * frameRate) / frameRate, field: burst.field, reason: selected ? 'after-selection' : 'before-edit' });
  }
  return { bursts, holds, warnings };
}
export function fieldRectangle(rect, geometry, frame) {
  if (!geometry?.region) return undefined;
  const crop = geometry.region;
  const x = Math.max(0, (rect.x - crop.x) * frame.width / crop.width);
  const y = Math.max(0, (rect.y - crop.y) * frame.height / crop.height);
  const right = Math.min(frame.width, (rect.x + rect.width - crop.x) * frame.width / crop.width);
  const bottom = Math.min(frame.height, (rect.y + rect.height - crop.y) * frame.height / crop.height);
  if (right <= x || bottom <= y) return undefined;
  return { x, y, width: right - x, height: bottom - y };
}
export function planEditingOverlays(editing, playback, geometry, frame) {
  const overlays = [];
  const add = (start, end, rect, label) => {
    const mapped = fieldRectangle(rect, geometry, frame);
    if (end > start && mapped) overlays.push({ start, end, rect: mapped, label });
  };
  for (const segment of playback) {
    if (segment.type === 'autoHold') {
      add(segment.outputStart, segment.outputEnd, editing.holds[segment.holdIndex].field.rect, 'Next: edit');
      continue;
    }
    if (segment.type !== 'video') continue;
    for (const [index, burst] of editing.bursts.entries()) {
      const start = Math.floor(burst.start * frameRate) / frameRate;
      const next = Math.min(burst.blurAt ?? Infinity, editing.bursts[index + 1]?.start ?? Infinity);
      const end = Math.min(Math.max(burst.end + 0.4, burst.start + 0.6), Math.floor(next * frameRate) / frameRate);
      const positions = [{ t: start, rect: burst.field.rect }, ...burst.positions];
      for (const [i, position] of positions.entries()) {
        const a = Math.max(position.t, segment.startFrame / frameRate), b = Math.min(positions[i + 1]?.t ?? end, end, segment.endFrame / frameRate);
        add(segment.outputStart + a - segment.startFrame / frameRate, segment.outputStart + b - segment.startFrame / frameRate, position.rect, 'Editing');
      }
    }
  }
  const merged = [];
  for (const item of overlays.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && Math.abs(last.end - item.start) < 0.001 && last.label === item.label && JSON.stringify(last.rect) === JSON.stringify(item.rect)) last.end = item.end;
    else merged.push({ ...item });
  }
  return merged;
}
export function editingSvg(rect, label, frame, pixelFrame = frame) {
  const x = Math.max(1.5, rect.x - 2), y = Math.max(1.5, rect.y - 2);
  const width = Math.min(frame.width - x - 1.5, rect.width + 4), height = Math.min(frame.height - y - 1.5, rect.height + 4);
  const badgeWidth = label === 'Next: edit' ? 75 : 60;
  const bx = Math.max(0, Math.min(frame.width - badgeWidth, x + width - badgeWidth)), by = y >= 23 ? y - 23 : Math.min(frame.height - 20, y + height + 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelFrame.width}" height="${pixelFrame.height}" viewBox="0 0 ${frame.width} ${frame.height}" preserveAspectRatio="none"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="5" fill="none" stroke="#e63046" stroke-width="3"/><rect x="${bx}" y="${by}" width="${badgeWidth}" height="20" rx="4" fill="#be123c"/><text x="${bx + 7}" y="${by + 14}" font-family="sans-serif" font-size="12" fill="white">${label}</text></svg>`;
}
