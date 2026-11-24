import { frameRate } from './playback.js';

export const cursorFrameRate = 30;
export const minimumJerk = t => {
  const u = Math.max(0, Math.min(1, t));
  return u * u * u * (10 + u * (-15 + 6 * u));
};
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
export const travelSeconds = pixels => Math.min(0.65, 0.18 + Math.sqrt(pixels) * 0.014);
export function cursorEnabled(metadata) {
  return metadata.animateCursor === true && (metadata.cursorWindows ? metadata.cursorWindows.length > 0 : metadata.cursorSuppression?.safeForAnimation === true);
}
export function cursorAnchors(samples = []) {
  const anchors = [];
  for (const sample of samples.filter(p => ['pointermove', 'pointerdown', 'pointerup'].includes(p.type) && [p.t, p.x, p.y].every(Number.isFinite) && p.t >= 0).sort((a, b) => a.t - b.t)) {
    const previous = anchors.at(-1);
    if (previous && previous.cursorSpan === sample.cursorSpan && distance(previous, sample) < 0.5) {
      if (sample.type === 'pointerup') { previous.buttons = 0; continue; }
      if (sample.type === 'pointermove') continue;
      if (sample.type === 'pointerdown' && previous.type === 'pointermove' && sample.t - previous.t < 0.12) { Object.assign(previous, sample); continue; }
    }
    anchors.push({ ...sample });
  }
  return anchors;
}
export function outputTime(t, playback) {
  const videos = playback.filter(s => s.type === 'video');
  const segment = videos.find(s => t >= s.startFrame / frameRate && t < s.endFrame / frameRate);
  if (segment) return segment.outputStart + t - segment.startFrame / frameRate;
  return videos.find(s => s.startFrame / frameRate >= t)?.outputStart ?? playback.at(-1)?.outputEnd ?? 0;
}
function isJump(from, to) {
  return !from.buttons && !(to.type === 'pointermove' && to.buttons) && distance(from, to) > 12 && (to.t - from.t > 0.12 || to.type === 'pointerdown');
}
function releasedAnchor(anchors, index) {
  const from = anchors[index - 1];
  // Older captures have no button state; pointerdown alone does not establish a drag.
  return from.type === 'pointerdown' && from.buttons === undefined ? { ...from, type: 'pointerup' } : from;
}
function barrier(playback, start, end) {
  return Math.max(start, ...playback.filter(s => ['callout', 'autoHold'].includes(s.type) && s.outputEnd <= end && s.outputEnd > start).map(s => s.outputEnd));
}
export function planCursorHolds(metadata, playback) {
  const holds = [], warnings = [];
  if (!cursorEnabled(metadata) || metadata.preserveTiming) return { holds, warnings };
  const anchors = cursorAnchors(metadata.pointerSamples);
  const groups = new Map();
  anchors.forEach((anchor, i) => { const frame = Math.floor(anchor.t * frameRate); groups.set(frame, [...(groups.get(frame) || []), i]); });
  const shared = new Set([...groups.values()].filter(indices => indices.filter(i => anchors[i].type === 'pointerdown').length > 1).flat());
  for (let i = 0; i < anchors.length; i++) {
    const to = anchors[i], from = i ? releasedAnchor(anchors, i) : to;
    if (from.cursorSpan !== to.cursorSpan) continue;
    const sourceFrame = Math.floor(to.t * frameRate) - 1;
    if (metadata.cursorWindows && Math.max(0, sourceFrame) / frameRate < metadata.cursorWindows[to.cursorSpan].start) continue;
    const sharedFrame = shared.has(i);
    const field = metadata.events?.find(event => event.type === 'pointerdown' && event.t === to.t)?.field;
    const editSoon = to.type === 'pointerdown' && field && metadata.events.some(event => event.type === 'input' && event.field?.id === field.id && event.t >= to.t && event.t - to.t < 0.2);
    const arrivalPause = editSoon ? 0.2 : 0.12;
    if (!sharedFrame && !editSoon && (!i || !isJump(from, to))) continue;
    const end = outputTime(to.t, playback);
    const start = barrier(playback, outputTime(from.t, playback) + 0.08, end);
    const travel = distance(from, to) > 0.5 ? travelSeconds(distance(from, to)) : 0;
    const missing = sharedFrame ? travel : travel - Math.max(0, end - start);
    if (!sharedFrame && !editSoon && missing <= 1 / cursorFrameRate) continue;
    if (sharedFrame) warnings.push(`Cursor actions near ${to.t.toFixed(3)}s share a captured backdrop; intermediate page states were not recorded.`);
    holds.push({ sourceFrame: Math.max(0, sourceFrame), frame: Math.max(0, sourceFrame + 1), anchorIndex: i, holdSeconds: Math.ceil((Math.max(0, missing) + arrivalPause) * frameRate) / frameRate, arrivalPause, sharedFrame, reason: 'cursor-travel' });
  }
  return { holds, warnings };
}
function cursorVisibility(windows, anchors, arrivals, playback, callouts) {
  if (!windows) return undefined;
  return windows.flatMap((window, index) => {
    const first = anchors.findIndex(anchor => anchor.cursorSpan === index);
    if (first < 0) return [];
    return playback.flatMap(segment => {
      let start, end;
      if (segment.type === 'video') {
        const inputStart = segment.startFrame / frameRate;
        start = segment.outputStart + Math.max(0, window.start - inputStart);
        end = segment.outputStart + Math.min(segment.endFrame / frameRate, window.end) - inputStart;
      } else {
        const input = callouts?.[segment.calloutIndex]?.at ?? segment.sourceFrame / frameRate;
        if (input < window.start || input >= window.end) return [];
        start = segment.outputStart;
        end = segment.outputEnd;
      }
      start = Math.max(start, arrivals[first]);
      return end > start ? [{ start, end }] : [];
    });
  });
}
export function planCursor(metadata, playback, geometry, frame, holds = []) {
  const region = geometry?.region;
  if (!region) return { enabled: false, reason: 'No crop geometry.' };
  const anchors = cursorEnabled(metadata) ? cursorAnchors(metadata.pointerSamples) : [];
  const arrivals = anchors.map(p => outputTime(p.t, playback));
  for (const segment of playback.filter(s => s.type === 'cursorHold')) arrivals[holds[segment.holdIndex].anchorIndex] = segment.outputEnd - (holds[segment.holdIndex].arrivalPause ?? 0.12);
  const movements = [], clicks = (metadata.cursorRingOnly || []).map(p => ({ t: outputTime(p.t, playback), x: p.x, y: p.y }));
  for (let i = 0; i < anchors.length; i++) {
    const to = anchors[i], end = arrivals[i];
    const from = i ? releasedAnchor(anchors, i) : to;
    const separated = from.cursorSpan !== to.cursorSpan;
    const earliest = i ? arrivals[i - 1] : end;
    const smooth = i > 0 && !separated && isJump(from, to);
    const start = smooth ? Math.max(barrier(playback, earliest + 0.08, end), end - travelSeconds(distance(from, to))) : separated ? end : earliest;
    if (to.type === 'pointerdown') clicks.push({ t: end, x: to.x, y: to.y });
    movements.push({ start: Math.min(start, end), end, from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, smooth });
  }
  const enabled = movements.length > 0;
  const reason = enabled ? undefined : 'No verified cursor positions in this clip.';
  return { enabled, reason, model: 'minimum-jerk', fps: cursorFrameRate, simulated: enabled, region, scaleX: frame.width / region.width, scaleY: frame.height / region.height, width: frame.width, height: frame.height, movements, clicks: clicks.sort((a, b) => a.t - b.t), visibility: cursorVisibility(metadata.cursorWindows, anchors, arrivals, playback, metadata.callouts), freezes: playback.filter(s => ['callout', 'autoHold'].includes(s.type)).map(s => ({ start: s.outputStart, end: s.outputEnd })) };
}
const inVisibility = (plan, t) => !plan.visibility || plan.visibility.some(w => t >= w.start && t < w.end);
export function cursorAt(plan, t) {
  if (!plan.enabled || t < plan.movements[0].end || !inVisibility(plan, t)) return null;
  const freeze = plan.freezes.find(s => t >= s.start && t < s.end);
  if (freeze) t = freeze.start - 0.000001;
  if (!inVisibility(plan, t) || t < plan.movements[0].end) return null;
  const next = plan.movements.find(m => t < m.end);
  const movement = next || plan.movements.at(-1);
  const u = movement.end > movement.start ? Math.max(0, Math.min(1, (t - movement.start) / (movement.end - movement.start))) : Number(t >= movement.end);
  const progress = movement.smooth ? minimumJerk(u) : u;
  const x = (movement.from.x + (movement.to.x - movement.from.x) * progress - plan.region.x) * plan.scaleX;
  const y = (movement.from.y + (movement.to.y - movement.from.y) * progress - plan.region.y) * plan.scaleY;
  return x < 0 || y < 0 || x >= plan.width || y >= plan.height ? null : { x, y };
}
export const cursorSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="30"><path d="M2 2 L2 21 L7 17 L11 25 L15 23 L11 15 L18 15 Z" fill="#111827" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg>';

export const ringSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="896" height="64">${Array.from({ length: 14 }, (_, i) => `<circle cx="${i * 64 + 32}" cy="32" r="${22 + i * 0.6}" fill="none" stroke="#ef233c" stroke-width="2" opacity="${1 - i / 14}"/>`).join('')}</svg>`;

function piecewise(pieces, fallback) {
  return pieces.map(({ start, end, value }) => `if(gte(t,${start})*lt(t,${end}),${value},0)`).concat([fallback]).join('+');
}
export function cursorExpressions(plan, overlayScale = 1) {
  const duration = plan.movements.at(-1).end;
  const position = axis => {
    const scale = axis === 'x' ? plan.scaleX : plan.scaleY;
    const limit = axis === 'x' ? plan.width : plan.height;
    const pieces = plan.movements.map((m, i) => {
      const u = `clip((t-${m.start})/${Math.max(0.000001, m.end - m.start)},0,1)`;
      const progress = m.smooth ? `(pow(${u},3)*(10+${u}*(-15+6*${u})))` : u;
      return { start: i ? plan.movements[i - 1].end : m.end, end: m.end, value: `${(m.from[axis] - plan.region[axis]) * scale}+${(m.to[axis] - m.from[axis]) * scale}*${progress}` };
    }).filter(p => p.end > p.start);
    const last = (plan.movements.at(-1).to[axis] - plan.region[axis]) * scale;
    let expression = piecewise(pieces, `if(gte(t,${duration}),${last},0)`);
    for (const freeze of plan.freezes) {
      const point = cursorAt(plan, freeze.start);
      expression = `if(gte(t,${freeze.start})*lt(t,${freeze.end}),${point ? point[axis] : -100},${expression})`;
    }
    const before = plan.movements[0].end;
    const visible = plan.visibility ? piecewise(plan.visibility.map(w => ({ ...w, value: 1 })), '0') : '1';
    return `st(0,${expression});if((${visible})*gte(t,${before})*gte(ld(0),0)*lt(ld(0),${limit}),ld(0)-${2 * overlayScale},-100)`;
  };
  return { x: position('x'), y: position('y'), ...ringExpressions(plan, overlayScale) };
}
export function ringExpressions(plan, overlayScale = 1) {
  const clicks = plan.clicks.map((c, i) => ({ ...c, end: Math.min(c.t + 0.45, plan.clicks[i + 1]?.t ?? Infinity) }));
  const ring = axis => {
    const scale = axis === 'x' ? plan.scaleX : plan.scaleY;
    return `${-100 * overlayScale}+${piecewise(clicks.map(c => ({ start: c.t, end: c.end, value: (c[axis] - plan.region[axis]) * scale + 68 * overlayScale })), '0')}`;
  };
  return { ringX: ring('x'), ringY: ring('y'), ringFrame: piecewise(clicks.map(c => ({ start: c.t, end: c.end, value: `${64 * overlayScale}*min(13,floor((t-${c.t})*30))` })), '0') };
}
