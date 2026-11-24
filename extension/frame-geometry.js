export function frameContentRect(frame, viewport) {
  if (![frame.width, frame.height, viewport.width, viewport.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('Capture frame and viewport must have positive dimensions.');
  const scale = Math.min(frame.width / viewport.width, frame.height / viewport.height);
  const width = viewport.width * scale, height = viewport.height * scale;
  return { x: (frame.width - width) / 2, y: (frame.height - height) / 2, width, height, scale };
}

export function sourceCrop(frame, geometry) {
  const content = frameContentRect(frame, geometry.viewport), region = geometry.region;
  return { x: content.x + region.x * content.scale, y: content.y + region.y * content.scale, width: region.width * content.scale, height: region.height * content.scale };
}

export function recordingResolution(chromeFrame, viewport) {
  const targetScale = 2;
  const scale = Math.min(targetScale, frameContentRect(chromeFrame, viewport).scale);
  const even = pixels => Math.max(2, Math.floor((pixels + 1e-9) / 2) * 2);
  const recording = { width: even(viewport.width * scale), height: even(viewport.height * scale) };
  return { targetScale, scale, chromeFrame, recording };
}
