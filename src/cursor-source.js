import { frameRate } from './playback.js';

const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= 3;

export function selectCursorSource(metadata) {
  if (metadata.animateCursor && metadata.cursorCoverage) return selectCoveredSources(metadata);
  const tracking = metadata.cursorSuppression?.tracking;
  if (!metadata.animateCursor || !tracking) return metadata;
  if (!tracking.valid || !Number.isFinite(metadata.captureStartedAt)) {
    return { ...metadata, cursorSuppression: { ...metadata.cursorSuppression, safeForAnimation: false }, cursorSource: { name: 'unavailable' }, warnings: [...(metadata.warnings || []), 'Codex cursor positions could not be verified; animated cursor export was disabled.'] };
  }
  const points = tracking.points.map(point => ({ ...point, t: (point.at - metadata.captureStartedAt) / 1000 })).filter(point => [point.t, point.x, point.y, point.opacity].every(Number.isFinite)).sort((a, b) => a.t - b.t);
  const activity = (metadata.events || []).filter(event => event.type === 'tabActivity').sort((a, b) => a.t - b.t);
  let pointIndex = -1, activityIndex = -1;
  let active = metadata.geometry?.tabActive !== false, activeSince = -Infinity;
  const samples = [...(metadata.pointerSamples || [])].sort((a, b) => a.t - b.t);
  const selected = [];
  let foreground = 0, background = 0;
  for (const sample of samples) {
    while (activityIndex + 1 < activity.length && activity[activityIndex + 1].t <= sample.t) {
      const change = activity[++activityIndex];
      if (change.active !== active) activeSince = change.t;
      active = change.active;
    }
    if ((sample.tabActive ?? active) === false) { selected.push({ ...sample, source: 'background-page' }); background++; continue; }
    while (pointIndex + 1 < points.length && points[pointIndex + 1].t <= sample.t) pointIndex++;
    const matches = point => point && point.t >= activeSince - 0.05 && point.opacity > 0 && near(point, sample);
    let confirmed = matches(points[pointIndex]);
    // Overlay and input events travel independently; allow a small delivery-order skew.
    for (let i = pointIndex + 1; !confirmed && i < points.length && points[i].t <= sample.t + 0.15; i++) confirmed = matches(points[i]);
    if (confirmed) { selected.push({ ...sample, source: 'codex-overlay' }); foreground++; }
  }
  return { ...metadata, pointerSamples: selected, cursorSource: { name: 'codex-overlay-with-background-page-events', foregroundSamples: foreground, backgroundSamples: background, ignoredSamples: samples.length - selected.length } };
}


function matchesOverlay(points, sample) {
  let lo = 0, hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].t <= sample.t) lo = mid + 1;
    else hi = mid;
  }
  for (let i = Math.max(0, lo - 1); i < points.length && points[i].t <= sample.t + 0.15; i++) {
    if (points[i].opacity > 0 && near(points[i], sample)) return true;
  }
  return false;
}

function union(windows) {
  const merged = [];
  for (const window of windows.sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end) previous.end = Math.max(previous.end, window.end);
    else merged.push({ ...window });
  }
  return merged;
}

function selectCoveredSources(metadata) {
  const { cursorCoverage, captureStartedAt, duration } = metadata;
  const samples = [...(metadata.pointerSamples || [])].sort((a, b) => a.t - b.t);
  const at = stamp => (stamp - captureStartedAt) / 1000;
  const frameWindow = (start, end) => ({
    start: Math.max(0, Math.ceil(start * frameRate) / frameRate),
    end: end >= duration ? duration : Math.floor(end * frameRate) / frameRate,
  });
  const spans = cursorCoverage.spans.map(span => ({
    ...frameWindow(at(span.from) + 0.2, at(span.through)),
    points: span.points.map(([stamp, x, y, opacity]) => ({ t: at(stamp), x, y, opacity })).sort((a, b) => a.t - b.t),
  })).filter(span => span.end > span.start);

  const background = [];
  if (cursorCoverage.source === 'tab' && cursorCoverage.knownOverlay) {
    let inactiveSince = metadata.geometry.tabActive === false ? 0 : null;
    const activity = metadata.events.filter(event => event.type === 'tabActivity').sort((a, b) => a.t - b.t);
    for (const event of activity) {
      if (event.active === false) inactiveSince ??= event.t + 1 / frameRate;
      else if (inactiveSince !== null) {
        background.push(frameWindow(inactiveSince, event.t - 1 / frameRate));
        inactiveSince = null;
      }
    }
    if (inactiveSince !== null) background.push(frameWindow(inactiveSince, duration));
  }
  const windows = union([...background, ...spans.map(({ start, end }) => ({ start, end }))].filter(w => w.end > w.start));
  const contains = (window, sample) => sample.t >= window.start && sample.t < window.end;
  const selected = [], ringOnly = [];
  let foregroundSamples = 0, backgroundSamples = 0;
  for (const sample of samples) {
    const inBackground = sample.tabActive === false && background.some(w => contains(w, sample));
    const overlay = spans.findLast(w => contains(w, sample));
    const cursorSpan = windows.findIndex(w => contains(w, sample));
    if (inBackground) {
      selected.push({ ...sample, cursorSpan, source: 'background-page' });
      backgroundSamples++;
    } else if (overlay && matchesOverlay(overlay.points, sample)) {
      selected.push({ ...sample, cursorSpan, source: 'codex-overlay' });
      foregroundSamples++;
    } else if (!overlay && sample.type === 'pointerdown') ringOnly.push(sample);
  }

  return {
    ...metadata, pointerSamples: selected, cursorWindows: windows, cursorRingOnly: ringOnly,
    cursorSource: {
      name: 'codex-overlay-with-background-page-events', foregroundSamples, backgroundSamples,
      ignoredSamples: samples.length - selected.length, ringOnlyClicks: ringOnly.length,
    },
  };
}
