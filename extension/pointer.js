export function needsPointerOverlay(source, active) {
  return source === 'display' || active === false;
}

export function drawPointer(ctx, pointer, geometry, scale = 1) {
  const x = (pointer.x - geometry.region.x) * ctx.canvas.width / geometry.region.width;
  const y = (pointer.y - geometry.region.y) * ctx.canvas.height / geometry.region.height;
  if (x < 0 || y < 0 || x >= ctx.canvas.width || y >= ctx.canvas.height) return;
  ctx.save();
  ctx.translate(x, y);
  if (scale !== 1) ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(0, 19); ctx.lineTo(5, 15);
  ctx.lineTo(9, 23); ctx.lineTo(13, 21); ctx.lineTo(9, 13);
  ctx.lineTo(16, 13); ctx.closePath();
  ctx.fillStyle = '#111827'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  ctx.lineJoin = 'round'; ctx.stroke(); ctx.fill();
  ctx.restore();
}
