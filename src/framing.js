const margin = 56;
const minimumWidth = 480;
const minimumHeight = 270;
const clickTypes = new Set(['pointerdown', 'click', 'dragEnd']);
const editTypes = new Set(['beforeinput', 'input', 'editlayout']);

function clip(rect, viewport) {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return;
  const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
  const right = Math.min(viewport.width, rect.x + rect.width);
  const bottom = Math.min(viewport.height, rect.y + rect.height);
  if (right > x && bottom > y) return { x, y, width: right - x, height: bottom - y };
}

function paddedAxis(start, end, viewport, minimum) {
  const size = Math.min(viewport, Math.max(end - start + margin * 2, minimum));
  const first = Math.max(0, Math.min(viewport - size, (start + end - size) / 2));
  return [first, first + size];
}

export function planFraming(metadata, sourceFrame) {
  const { viewport } = metadata.geometry;
  const scaleX = sourceFrame.width / viewport.width, scaleY = sourceFrame.height / viewport.height;
  const full = { x: 0, y: 0, width: sourceFrame.width, height: sourceFrame.height };
  const anchors = { clicks: 0, edits: 0, callouts: 0, included: 0 };
  const finish = (reason, pixels = full) => ({ reason, pixels, anchors, region: { x: pixels.x / scaleX, y: pixels.y / scaleY, width: pixels.width / scaleX, height: pixels.height / scaleY } });
  if (metadata.framing === 'viewport') return finish('requested-viewport');
  if (metadata.viewportChanged) return finish('viewport-changed');

  const evidence = [];
  const add = (rect, kind) => {
    const visible = clip(rect, viewport);
    if (visible) { evidence.push(visible); anchors[kind]++; }
  };
  const distinctClicks = [];
  for (const event of metadata.events) {
    if (clickTypes.has(event.type) && Number.isFinite(event.x) && Number.isFinite(event.y)) {
      if (!distinctClicks.some(point => Math.hypot(point.x - event.x, point.y - event.y) < 32)) distinctClicks.push(event);
      add({ x: event.x - 1, y: event.y - 1, width: 2, height: 2 }, 'clicks');
      const rect = event.targetRect;
      if (rect && rect.width * rect.height <= viewport.width * viewport.height / 2) {
        const visible = clip(rect, viewport);
        if (visible) evidence.push(visible);
      }
    }
    if (editTypes.has(event.type) || event.keyLabel) add(event.field?.rect, 'edits');
  }
  for (const included of metadata.includes || []) add(included.rect, 'included');
  for (const callout of metadata.callouts || []) {
    for (const target of callout.geometry?.highlights || []) add(target.rect, 'callouts');
    for (const item of callout.annotations?.items || []) {
      if (item.label?.footer) return finish('callout-legend');
      if (!item.label) continue;
      const { x, y, width, height } = item.label;
      const visible = clip({ x: x / scaleX, y: y / scaleY, width: width / scaleX, height: height / scaleY }, viewport);
      if (visible) evidence.push(visible);
    }
  }
  if (!evidence.length || (distinctClicks.length < 2 && !anchors.edits && !anchors.callouts && !anchors.included)) return finish('limited-evidence');
  const [left, right] = paddedAxis(Math.min(...evidence.map(r => r.x)), Math.max(...evidence.map(r => r.x + r.width)), viewport.width, minimumWidth);
  const [top, bottom] = paddedAxis(Math.min(...evidence.map(r => r.y)), Math.max(...evidence.map(r => r.y + r.height)), viewport.height, minimumHeight);
  // Round out to even pixel boundaries for 4:2:0 video.
  const x = Math.floor(left * scaleX / 2) * 2, y = Math.floor(top * scaleY / 2) * 2;
  const width = Math.min(full.width, Math.ceil(right * scaleX / 2) * 2) - x;
  const height = Math.min(full.height, Math.ceil(bottom * scaleY / 2) * 2) - y;
  if (width * height >= full.width * full.height * 0.85) return finish('wide-evidence');
  return finish('interaction-bounds', { x, y, width, height });
}
