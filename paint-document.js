// Layer order is bottom to top, both in memory and in project backups.
export function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function validSize(width, height) {
  return [width, height].every(n => Number.isInteger(n) && n > 0 && n <= 8000);
}

export function transformedSize(width, height, skewX = 0, skewY = 0) {
  const dx = height * Math.tan(skewX * Math.PI / 180);
  const dy = width * Math.tan(skewY * Math.PI / 180);
  return { width: Math.ceil(width + Math.abs(dx) - 1e-8), height: Math.ceil(height + Math.abs(dy) - 1e-8), dx, dy };
}

export function resizeBitmap(source, width, height, scaleContent, skewX = 0, skewY = 0) {
  const size = transformedSize(width, height, skewX, skewY);
  const canvas = makeCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(1, size.dy / width, size.dx / height, 1, -Math.min(0, size.dx), -Math.min(0, size.dy));
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  if (scaleContent) ctx.drawImage(source, 0, 0, width, height);
  else ctx.drawImage(source, 0, 0);
  return canvas;
}

export function newLayer(width, height, name) {
  return { id: crypto.randomUUID(), name, visible: true, canvas: makeCanvas(width, height), png: null };
}

export function boardSnapshot(board) {
  if (board.layers?.length) return board;
  const id = 'base';
  return { ...board, activeLayerId: id, layers: [
    { id, name: 'Layer 1', visible: true, png: board.canvasData || null }
  ] };
}

export async function restoreLayers(snapshot) {
  return Promise.all(snapshot.layers.map(async record => {
    const canvas = makeCanvas(snapshot.width, snapshot.height);
    if (record.png) {
      const image = new Image();
      image.src = record.png;
      await image.decode();
      canvas.getContext('2d', { willReadFrequently: true }).drawImage(image, 0, 0);
    }
    return { ...record, canvas };
  }));
}

function validTable(table, board) {
  if (!table) return false;
  const { x, y, width, height, rows, columns, color, opacity, fontFamily, fontSize, cells, borderWidth = 2 } = table;
  return [rows, columns].every(n => Number.isInteger(n) && n >= 1 && n <= 30) &&
    [x, y, width, height].every(Number.isInteger) && x >= 0 && y >= 0 &&
    width >= columns * 8 && height >= rows * 10 &&
    x + width <= board.width && y + height <= board.height &&
    typeof color === 'string' && /^#[\da-f]{6}$/i.test(color) &&
    Number.isFinite(opacity) && opacity >= 0 && opacity <= 1 &&
    typeof fontFamily === 'string' && fontFamily.length > 0 && fontFamily.length <= 120 &&
    Number.isInteger(fontSize) && fontSize >= 8 && fontSize <= 200 &&
    Number.isInteger(borderWidth) && borderWidth >= 2 && borderWidth <= 8 &&
    Array.isArray(cells) && cells.length === rows * columns &&
    cells.every(text => typeof text === 'string' && text.length <= 200 && !/[\r\n]/.test(text));
}

// Import only PaintBoard's own embedded image data. Validate before replacing
// the current workspace so a bad backup cannot partially apply.
export function readProjectBoards(records) {
  const isPng = value => value == null || (typeof value === 'string' && value.startsWith('data:image/png;base64,'));
  const isLabel = value => typeof value === 'string' && value.trim().length > 0;
  if (!Array.isArray(records) || records.length === 0) throw new Error('No boards in project');
  const boardIds = new Set();
  return records.map(raw => {
    if (!raw || !validSize(raw.width, raw.height) || !isLabel(raw.name) ||
        !/^[\w-]+$/.test(raw.id) || typeof raw.id !== 'string' || boardIds.has(raw.id) ||
        !/^(transparent|#[\da-f]{6})$/i.test(raw.background) || !isPng(raw.canvasData)) {
      throw new Error('Invalid board');
    }
    boardIds.add(raw.id);
    const board = boardSnapshot(raw);
    const layerIds = new Set();
    if (!Array.isArray(board.layers) || !board.layers.length || board.layers.some(layer => {
      if (!layer || !isLabel(layer.id) || layerIds.has(layer.id) || !isLabel(layer.name) ||
          typeof layer.visible !== 'boolean' || !isPng(layer.png) ||
          (layer.table !== undefined && !validTable(layer.table, board)) ||
          (layer.tableBitmap !== undefined && (layer.tableBitmap !== true || layer.table !== undefined))) return true;
      layerIds.add(layer.id);
      return false;
    }) || !layerIds.has(board.activeLayerId)) throw new Error('Invalid layer stack');
    return { ...board, thumbnail: /^data:image\/(jpeg|png);base64,[a-z\d+/=]+$/i.test(board.thumbnail) ? board.thumbnail : null };
  });
}
