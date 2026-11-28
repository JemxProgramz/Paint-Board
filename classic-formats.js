import { makeCanvas, validSize } from './paint-document.js';

export async function exportPaintFile(canvas, format) {
  const { width, height } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
  if (format === 'tiff') {
    const { default: tiff } = await import('utif');
    const bytes = tiff.encodeImage(data.buffer, width, height, { t338: [2] });
    return new Blob([bytes], { type: 'image/tiff' });
  }
  if (format !== 'gif') throw new Error('Unsupported image format');
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
  const mode = 'rgba4444';
  const palette = quantize(data, 256, { format: mode, oneBitAlpha: true });
  const transparentIndex = palette.findIndex(color => color[3] === 0);
  const gif = GIFEncoder();
  gif.writeFrame(applyPalette(data, palette, mode), width, height, {
    palette, transparent: transparentIndex !== -1, transparentIndex: Math.max(0, transparentIndex)
  });
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}

export async function decodeTiff(file) {
  const { default: tiff } = await import('utif');
  const bytes = await file.arrayBuffer();
  const [page] = tiff.decode(bytes);
  if (!validSize(page?.t256?.[0], page?.t257?.[0])) throw new Error('Unsupported TIFF size');
  tiff.decodeImage(bytes, page);
  const canvas = makeCanvas(page.width, page.height);
  const ctx = canvas.getContext('2d');
  const pixels = ctx.createImageData(page.width, page.height);
  pixels.data.set(tiff.toRGBA8(page));
  ctx.putImageData(pixels, 0, 0);
  const image = new Image();
  image.src = canvas.toDataURL();
  await image.decode();
  return image;
}
