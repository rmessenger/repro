const gap = 8, lineHeight = 18;
const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
export const overlaps = (a, b, padding = 0) => a.x < b.x + b.width + padding && a.x + a.width + padding > b.x && a.y < b.y + b.height + padding && a.y + a.height + padding > b.y;

function wrap(text, maxWidth, measure) {
  const lines = []; let line = '';
  for (const word of text.split(/\s+/)) {
    const joined = line ? `${line} ${word}` : word;
    if (measure(joined) <= maxWidth) { line = joined; continue; }
    if (line) { lines.push(line); line = ''; }
    for (const char of word) {
      if (line && measure(line + char) > maxWidth) { lines.push(line); line = ''; }
      line += char;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function layoutAnnotations(geometry, canvas, measure) {
  const sx = canvas.width / geometry.region.width, sy = canvas.height / geometry.region.height;
  const items = geometry.highlights.map((h, index) => {
    const x = clamp((h.rect.x - geometry.region.x) * sx, 0, canvas.width);
    const y = clamp((h.rect.y - geometry.region.y) * sy, 0, canvas.height);
    const right = clamp((h.rect.x + h.rect.width - geometry.region.x) * sx, 0, canvas.width);
    const bottom = clamp((h.rect.y + h.rect.height - geometry.region.y) * sy, 0, canvas.height);
    if (right <= x || bottom <= y) throw new Error('An annotation target is outside the screenshot crop. Include it in region or use a full-page viewport screenshot.');
    return { index: index + 1, style: h.style, text: h.label, rect: { x, y, width: right - x, height: bottom - y } };
  });
  const placed = []; let footer = canvas.height;
  for (const [index, item] of items.entries()) {
    if (!item.text) continue;
    const maxWidth = Math.max(1, Math.min(300, canvas.width - 24));
    let lines = wrap(item.text, maxWidth, measure);
    let width = Math.min(canvas.width, Math.max(...lines.map(measure)) + 12), height = lines.length * lineHeight + 8;
    const r = item.rect;
    const rightX = r.x + r.width + gap;
    const xs = [clamp(r.x, 0, canvas.width - width), clamp(r.x + r.width - width, 0, canvas.width - width), clamp(r.x - width - gap, 0, canvas.width - width), clamp(rightX, 0, canvas.width - width)];
    const ys = [r.y - height - gap, r.y + r.height + gap, r.y];
    const candidates = xs.flatMap(x => ys.map(y => ({ x, y, width, height })));
    if (geometry.highlights[index].labelPlacement === 'right' && rightX + width <= canvas.width) {
      const y = clamp(r.y + (r.height - height) / 2, 0, canvas.height - height);
      candidates.unshift({ x: rightX, y, width, height });
    }
    const position = candidates.find(candidate => candidate.y >= 0 && candidate.y + height <= canvas.height && !items.some(other => overlaps(candidate, other.rect, 4)) && !placed.some(other => overlaps(candidate, other, gap)));
    if (position) {
      item.label = { ...position, lines, footer: false };
      placed.push(position);
    } else {
      lines = wrap(`${item.index}. ${item.text}`, Math.max(1, canvas.width - 28), measure);
      width = Math.min(canvas.width - 8, Math.max(...lines.map(measure)) + 12); height = lines.length * lineHeight + 8;
      item.label = { x: 4, y: footer + gap, width, height, lines, footer: true };
      footer += height + gap;
    }
  }
  return { items, height: footer > canvas.height ? footer + gap : canvas.height };
}

export function drawAnnotations(ctx, layout, canvasWidth = ctx.canvas.width) {
  ctx.save();
  ctx.strokeStyle = '#ef233c'; ctx.fillStyle = '#ef233c'; ctx.lineWidth = 3;
  for (const item of layout.items) {
    const { x, y, width, height } = item.rect;
    if (item.style === 'arrow') {
      const ex = x + width / 2, ey = y + height / 2, bx = Math.max(8, x - 25), by = Math.max(8, y - 25);
      const angle = Math.atan2(ey - by, ex - bx);
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(ex, ey);
      ctx.moveTo(ex - 12 * Math.cos(angle - 0.5), ey - 12 * Math.sin(angle - 0.5)); ctx.lineTo(ex, ey); ctx.lineTo(ex - 12 * Math.cos(angle + 0.5), ey - 12 * Math.sin(angle + 0.5)); ctx.stroke();
    } else ctx.strokeRect(x + 1.5, y + 1.5, Math.max(0, width - 3), Math.max(0, height - 3));
    const label = item.label;
    if (label && !label.footer) {
      const lx = clamp(x + width / 2, label.x, label.x + label.width), ly = clamp(y + height / 2, label.y, label.y + label.height);
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(clamp(lx, x, x + width), clamp(ly, y, y + height)); ctx.stroke(); ctx.lineWidth = 3;
    }
  }
  ctx.font = 'bold 14px sans-serif'; ctx.textBaseline = 'top';
  for (const item of layout.items) {
    const label = item.label;
    if (!label) continue;
    ctx.fillStyle = '#c91232'; ctx.fillRect(label.x, label.y, label.width, label.height);
    ctx.fillStyle = '#fff';
    label.lines.forEach((line, i) => ctx.fillText(line, label.x + 6, label.y + 4 + i * lineHeight));
    if (label.footer) {
      const x = clamp(item.rect.x, 0, Math.max(0, canvasWidth - 24)), y = Math.max(0, item.rect.y - 23);
      ctx.fillStyle = '#c91232'; ctx.fillRect(x, y, 24, 22);
      ctx.fillStyle = '#fff'; ctx.fillText(String(item.index), x + 5, y + 3);
    }
  }
  ctx.restore();
}
