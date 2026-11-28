import { makeCanvas, validSize } from './paint-document.js';

export function scaleBitmap(source, width, height) {
  const result = makeCanvas(width, height);
  const ctx = result.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0, width, height);
  return result;
}

export function transformBitmap(source, width, height, operation) {
  const turn = operation === 'rotate90' || operation === 'rotate270';
  const result = makeCanvas(turn ? height : width, turn ? width : height);
  const ctx = result.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  switch (operation) {
    case 'rotate90':  ctx.setTransform(0, 1, -1, 0, height, 0); break;
    case 'rotate180': ctx.setTransform(-1, 0, 0, -1, width, height); break;
    case 'rotate270': ctx.setTransform(0, -1, 1, 0, 0, width); break;
    case 'flipH': ctx.setTransform(-1, 0, 0, 1, width, 0); break;
    case 'flipV': ctx.setTransform(1, 0, 0, -1, 0, height); break;
  }
  ctx.drawImage(source, 0, 0, width, height);
  ctx.resetTransform();
  if (operation === 'invert') {
    const pixels = ctx.getImageData(0, 0, width, height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      if (!pixels.data[i + 3]) continue;
      pixels.data[i] = 255 - pixels.data[i];
      pixels.data[i + 1] = 255 - pixels.data[i + 1];
      pixels.data[i + 2] = 255 - pixels.data[i + 2];
    }
    ctx.putImageData(pixels, 0, 0);
  }
  return result;
}

// Normalize a pixel selection to a binary mask. Fractional edge coverage would
// leave halos when the selected pixels are cut and later put back.
export function trimSelectionMask(canvas, offsetX, offsetY) {
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  const pixels = ctx.getImageData(0, 0, width, height);
  let left = width, top = height, right = -1, bottom = -1, count = 0;
  for (let y = 0, i = 3; y < height; y++) {
    for (let x = 0; x < width; x++, i += 4) {
      const selected = pixels.data[i] >= 128;
      pixels.data[i] = selected ? 255 : 0;
      if (!selected) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      count++;
    }
  }
  if (!count) return null;
  const rect = { x: offsetX + left, y: offsetY + top, w: right - left + 1, h: bottom - top + 1 };
  if (count === rect.w * rect.h) return { rect, mask: null };
  const mask = makeCanvas(rect.w, rect.h);
  mask.getContext('2d').putImageData(pixels, -left, -top);
  return { rect, mask };
}

export function drawMaskOutline(outline, mask) {
  outline.hidden = !mask;
  if (!mask) {
    outline.width = outline.height = 1;
    return;
  }
  const { width, height } = mask;
  outline.width = width;
  outline.height = height;
  const src = mask.getContext('2d').getImageData(0, 0, width, height).data;
  const ctx = outline.getContext('2d');
  const edge = ctx.createImageData(width, height);
  const stride = width * 4;
  for (let y = 0, i = 3; y < height; y++) {
    for (let x = 0; x < width; x++, i += 4) {
      if (!src[i]) continue;
      if (x && y && x + 1 < width && y + 1 < height &&
          src[i - 4] && src[i + 4] && src[i - stride] && src[i + stride]) continue;
      const shade = ((x + y) >> 2) % 2 ? 255 : 0;
      edge.data[i - 3] = edge.data[i - 2] = edge.data[i - 1] = shade;
      edge.data[i] = 255;
    }
  }
  ctx.putImageData(edge, 0, 0);
}

// Shared by placed images and pixel selections. Bounds and deltas use artwork
// pixels, including when the viewport is zoomed or scrolled.
export function bindBitmapHandles(element, { coords, bounds, hitTest, update, finish }) {
  let gesture = null;
  function move(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const point = coords(event);
    const dx = point.x - gesture.start.x, dy = point.y - gesture.start.y;
    const r = gesture.rect, handle = gesture.handle;
    let { x, y, w, h } = r;
    if (!handle) {
      x += dx;
      y += dy;
    } else {
      if (handle.includes('w')) x = Math.min(r.x + r.w - 1, r.x + dx);
      if (handle.includes('n')) y = Math.min(r.y + r.h - 1, r.y + dy);
      w = handle.includes('e') ? Math.max(1, r.w + dx) : r.x + r.w - x;
      h = handle.includes('s') ? Math.max(1, r.h + dy) : r.y + r.h - y;
    }
    const current = bounds();
    if (!current || !validSize(w, h) || (current.x === x && current.y === y && current.w === w && current.h === h)) return;
    gesture.changed = true;
    update({ x, y, w, h });
  }
  element.addEventListener('pointerdown', event => {
    if (event.target.closest('button')) { event.stopPropagation(); return; }
    const rect = bounds();
    if (!rect || gesture || event.button !== 0 || !event.isPrimary) return;
    const handle = event.target.closest('[data-handle]')?.dataset.handle.replace('img-', '');
    const start = coords(event);
    if (!handle && hitTest && !hitTest(start)) return;
    event.stopPropagation();
    event.preventDefault();
    gesture = { id: event.pointerId, rect: { ...rect }, handle, start, changed: false };
    element.setPointerCapture(event.pointerId);
  });
  element.addEventListener('pointermove', move);
  element.addEventListener('pointerup', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    move(event);
    const changed = gesture.changed;
    gesture = null;
    if (changed) finish?.();
  });
  element.addEventListener('lostpointercapture', event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    if (gesture.changed && bounds()) update(gesture.rect);
    gesture = null;
  });
}

export function bitmapBlob(canvas, type) {
  if (type !== 'image/bmp') {
    return new Promise((resolve, reject) => canvas.toBlob(blob => {
      if (blob && blob.type === type) resolve(blob);
      else reject(new Error('The browser could not encode this format.'));
    }, type, 0.95));
  }
  // Windows 24-bit BI_RGB stores BGR triples bottom-up, padded to 4-byte rows.
  const { width, height } = canvas;
  const stride = Math.ceil(width * 3 / 4) * 4;
  const bytes = new Uint8Array(54 + stride * height);
  const header = new DataView(bytes.buffer);
  bytes.set([0x42, 0x4d]);
  header.setUint32(2, bytes.length, true);
  header.setUint32(10, 54, true);
  header.setUint32(14, 40, true);
  header.setUint32(18, width, true);
  header.setUint32(22, height, true);
  header.setUint16(26, 1, true);
  header.setUint16(28, 24, true);
  header.setUint32(34, stride * height, true);
  const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  for (let y = 0; y < height; y++) {
    let from = y * width * 4, to = 54 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++, from += 4, to += 3) {
      bytes[to] = pixels[from + 2];
      bytes[to + 1] = pixels[from + 1];
      bytes[to + 2] = pixels[from];
    }
  }
  return new Blob([bytes], { type });
}
