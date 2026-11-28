// Shape outlines use the same 100 × 100 coordinate system in the gallery and on the canvas.
function starPath(points, innerRadius) {
  const vertices = [];
  for (let i = 0; i < points * 2; i++) {
    const angle = -Math.PI / 2 + i * Math.PI / points;
    const radius = i % 2 ? innerRadius : 50;
    vertices.push([50 + Math.cos(angle) * radius, 50 + Math.sin(angle) * radius]);
  }
  const xs = vertices.map(([x]) => x);
  const ys = vertices.map(([, y]) => y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const w = Math.max(...xs) - minX, h = Math.max(...ys) - minY;
  return vertices.map(([x, y], i) =>
    `${i ? 'L' : 'M'}${((x - minX) * 100 / w).toFixed(2)} ${((y - minY) * 100 / h).toFixed(2)}`
  ).join(' ') + ' Z';
}

export const SHAPES = {
  line: ['Line', 'M0 100 L100 0'],
  curve: ['Curve', 'M0 85 C35 100 45 -12 100 16'],
  circle: ['Ellipse', 'M50 0 A50 50 0 1 1 50 100 A50 50 0 1 1 50 0 Z'],
  rectangle: ['Rectangle', 'M0 0 H100 V100 H0 Z'],
  roundedRect: ['Rounded rectangle', 'M18 0 H82 Q100 0 100 18 V82 Q100 100 82 100 H18 Q0 100 0 82 V18 Q0 0 18 0 Z'],
  polygon: ['Polygon', 'M0 60 L38 0 L75 28 L100 76 L46 100 Z'],
  triangle: ['Triangle', 'M50 0 L100 100 H0 Z'],
  rightTriangle: ['Right triangle', 'M0 0 L100 100 H0 Z'],
  diamond: ['Diamond', 'M50 0 L100 50 L50 100 L0 50 Z'],
  pentagon: ['Pentagon', 'M50 0 L100 38 L81 100 H19 L0 38 Z'],
  hexagon: ['Hexagon', 'M24 0 H76 L100 50 L76 100 H24 L0 50 Z'],
  rightArrow: ['Right arrow', 'M0 28 H57 V0 L100 50 L57 100 V72 H0 Z'],
  leftArrow: ['Left arrow', 'M100 28 H43 V0 L0 50 L43 100 V72 H100 Z'],
  upArrow: ['Up arrow', 'M28 100 V43 H0 L50 0 L100 43 H72 V100 Z'],
  downArrow: ['Down arrow', 'M28 0 V57 H0 L50 100 L100 57 H72 V0 Z'],
  fourPointStar: ['Four-point star', starPath(4, 14)],
  fivePointStar: ['Five-point star', starPath(5, 20)],
  sixPointStar: ['Six-point star', starPath(6, 26)],
  rectCallout: ['Rectangular callout', 'M0 0 H100 V76 H45 L22 100 L29 76 H0 Z'],
  ovalCallout: ['Oval callout', 'M28 74 C-18 56 -7 0 50 0 C114 0 118 78 54 80 L40 80 L18 100 Z'],
  cloudCallout: ['Cloud callout', 'M17 57 C-5 62 -5 34 9 29 C3 10 21 1 33 9 C40 -3 58 -3 66 8 C84 0 99 11 94 25 C110 36 97 56 84 55 C79 72 60 76 50 66 C40 76 25 72 22 63 Z M19 77 A6 6 0 1 1 19 89 A6 6 0 1 1 19 77 Z M6 94 A3 3 0 1 1 6 100 A3 3 0 1 1 6 94 Z'],
  heart: ['Heart', 'M50 100 C41 88 0 61 0 29 C0 -1 34 -11 50 16 C66 -11 100 -1 100 29 C100 61 59 88 50 100 Z'],
  lightning: ['Lightning', 'M39 0 H82 L59 37 H95 L22 100 L43 56 H9 Z']
};

export const BRUSHES = {
  round: 'Brush',
  calligraphy: 'Calligraphy brush',
  calligraphyAlt: 'Calligraphy pen',
  airbrush: 'Airbrush',
  oil: 'Oil brush',
  crayon: 'Crayon',
  marker: 'Marker',
  naturalPencil: 'Natural pencil',
  watercolor: 'Watercolor',
  soft: 'Soft brush',
  square: 'Square brush'
};

export function snapLine(start, end) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
  const length = Math.hypot(dx, dy);
  return { x: start.x + length * Math.cos(angle), y: start.y + length * Math.sin(angle) };
}

export function shapePath(tool, start, end, constrained) {
  const path = new Path2D();
  if (tool === 'line') {
    const tip = constrained ? snapLine(start, end) : end;
    path.moveTo(start.x, start.y);
    path.lineTo(tip.x, tip.y);
    return path;
  }
  let dx = end.x - start.x, dy = end.y - start.y;
  if (constrained) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = dx < 0 ? -side : side;
    dy = dy < 0 ? -side : side;
  }
  const x = Math.min(start.x, start.x + dx), y = Math.min(start.y, start.y + dy);
  const width = Math.abs(dx), height = Math.abs(dy);
  if (tool === 'roundedRect') {
    path.roundRect(x, y, width, height, Math.min(width / 4, height / 4, 18));
  } else {
    path.addPath(new Path2D(SHAPES[tool][1]), new DOMMatrix([width / 100, 0, 0, height / 100, x, y]));
  }
  return path;
}

export function polygonPath(vertices, closed) {
  const path = new Path2D();
  if (vertices.length) {
    path.moveTo(vertices[0].x, vertices[0].y);
    for (const vertex of vertices.slice(1)) path.lineTo(vertex.x, vertex.y);
    if (closed) path.closePath();
  }
  return path;
}

export function tableCellLayout(table) {
  const width = table.width / table.columns;
  const height = table.height / table.rows;
  const padding = Math.min(8, width / 4);
  return { width, height, padding, fontSize: Math.min(table.fontSize, height - 2) };
}

export function paintTable(ctx, table) {
  const { x, y, width, height, rows, columns, cells, color, opacity, fontFamily, borderWidth = 2 } = table;
  const cell = tableCellLayout(table);
  const path = new Path2D();
  for (let column = 0; column <= columns; column++) {
    const left = x + column * cell.width;
    path.moveTo(left, y);
    path.lineTo(left, y + height);
  }
  for (let row = 0; row <= rows; row++) {
    const top = y + row * cell.height;
    path.moveTo(x, top);
    path.lineTo(x + width, top);
  }
  paintShape(ctx, path, { color, opacity, size: borderWidth, outlineStyle: 'solid' }, { open: true });
  ctx.save();
  ctx.font = `${cell.fontSize}px ${fontFamily}`;
  ctx.fillStyle = color;
  ctx.globalAlpha = opacity;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  cells.forEach((text, index) => {
    if (!text) return;
    const left = x + (index % columns) * cell.width;
    const top = y + Math.floor(index / columns) * cell.height;
    ctx.fillText(text, left + cell.padding, top + cell.height / 2, cell.width - 2 * cell.padding);
  });
  ctx.restore();
}

// The user places points on the curve. Convert these points to Bézier control points.
export function curvePath(start, end, bends) {
  const path = new Path2D();
  path.moveTo(start.x, start.y);
  const dx = end.x - start.x, dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy || 1;
  const fraction = p => ((p.x - start.x) * dx + (p.y - start.y) * dy) / lengthSquared;
  if (!bends.length) {
    path.lineTo(end.x, end.y);
  } else if (bends.length === 1) {
    const t = Math.max(0.2, Math.min(0.8, fraction(bends[0])));
    const u = 1 - t;
    const control = axis => (bends[0][axis] - u * u * start[axis] - t * t * end[axis]) / (2 * u * t);
    path.quadraticCurveTo(control('x'), control('y'), end.x, end.y);
  } else {
    const [first, second] = [...bends].sort((a, b) => fraction(a) - fraction(b));
    // Interpolate both bends at one third and two thirds along a cubic.
    const control1 = k => 3 * first[k] - 1.5 * second[k] - 5 / 6 * start[k] + end[k] / 3;
    const control2 = k => 3 * second[k] - 1.5 * first[k] - 5 / 6 * end[k] + start[k] / 3;
    path.bezierCurveTo(control1('x'), control1('y'), control2('x'), control2('y'), end.x, end.y);
  }
  return path;
}

const textureTiles = new Map();
const texturedStyles = new Set(['crayon', 'naturalPencil', 'oil', 'watercolor']);
const styleOpacity = { marker: 0.55, watercolor: 0.40 };

function texture(ctx, color, kind) {
  if (!texturedStyles.has(kind)) return color;
  const key = kind + color;
  let tile = textureTiles.get(key);
  if (!tile) {
    tile = document.createElement('canvas');
    tile.width = tile.height = 64;
    const tileCtx = tile.getContext('2d');
    tileCtx.fillStyle = color;
    tileCtx.fillRect(0, 0, 64, 64);
    const image = tileCtx.getImageData(0, 0, 64, 64);
    let seed = 421;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const grain = seed / 4294967296;
        let alpha;
        if (kind === 'oil') {
          alpha = 0.55 + 0.30 * Math.cos(Math.PI * (x + y) / 4) + 0.15 * grain;
        } else if (kind === 'watercolor') {
          alpha = 0.67 + 0.15 * Math.cos(Math.PI * x / 16) + 0.18 * grain;
        } else if (kind === 'naturalPencil') {
          alpha = grain < 0.34 ? 0 : 0.18 + 0.65 * grain;
        } else {
          alpha = grain < 0.23 ? 0 : 0.55 + 0.45 * grain;
        }
        image.data[(y * 64 + x) * 4 + 3] = Math.round(255 * alpha);
      }
    }
    tileCtx.putImageData(image, 0, 0);
    if (textureTiles.size >= 24) textureTiles.delete(textureTiles.keys().next().value);
    textureTiles.set(key, tile);
  }
  return ctx.createPattern(tile, 'repeat');
}

export function paintShape(ctx, path, settings, { open = false, start, end } = {}) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = settings.size;
  if (!open && settings.mode !== 'stroke') {
    const fill = settings.fillStyle;
    ctx.globalAlpha = settings.opacity * (styleOpacity[fill] ?? 1);
    if (fill === 'gradient' && start && end && (start.x !== end.x || start.y !== end.y)) {
      const gradient = ctx.createLinearGradient(start.x, start.y, end.x, end.y);
      gradient.addColorStop(0, settings.fillColor);
      gradient.addColorStop(1, settings.color);
      ctx.fillStyle = gradient;
    } else {
      ctx.fillStyle = texture(ctx, settings.fillColor, fill);
    }
    ctx.fill(path);
  }
  if (open || settings.mode !== 'fill') {
    ctx.globalAlpha = settings.opacity * (styleOpacity[settings.outlineStyle] ?? 1);
    ctx.strokeStyle = texture(ctx, settings.color, settings.outlineStyle);
    ctx.stroke(path);
  }
  ctx.restore();
}

// Render ink into a transparent stroke buffer. The caller applies overall opacity once.
export function createStroke(ctx, { tip, size, color }, point) {
  const pigment = texture(ctx, color, tip);
  const broadNib = tip === 'calligraphy' || tip === 'calligraphyAlt' || tip === 'marker';
  const roundStroke = ['round', 'oil', 'crayon', 'naturalPencil', 'eraser'].includes(tip);
  let previous = point;
  let distanceToStamp = 0;
  const diameter = pressure => Math.max(1, size * pressure);

  function stamp(x, y, width) {
    const r = width / 2;
    ctx.fillStyle = pigment;
    if (tip === 'pencil' || tip === 'square') {
      const side = Math.max(1, Math.round(width));
      ctx.fillRect(Math.round(x - (side - 1) / 2), Math.round(y - (side - 1) / 2), side, side);
    } else if (tip === 'airbrush') {
      const spread = Math.max(2, width);
      const count = Math.max(4, Math.ceil(width * 0.8));
      const dot = Math.max(1, width / 30);
      for (let i = 0; i < count; i++) {
        const distance = Math.sqrt(Math.random()) * spread;
        const angle = Math.random() * 2 * Math.PI;
        ctx.fillRect(Math.floor(x + distance * Math.cos(angle)), Math.floor(y + distance * Math.sin(angle)), dot, dot);
      }
    } else if (tip === 'soft' || tip === 'watercolor') {
      const radius = tip === 'soft' ? width : r;
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, color + (tip === 'soft' ? '60' : 'a6'));
      gradient.addColorStop(0.7, color + (tip === 'soft' ? '24' : '66'));
      gradient.addColorStop(1, color + '00');
      ctx.fillStyle = gradient;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    } else {
      ctx.beginPath();
      if (broadNib) {
        const angle = tip === 'calligraphyAlt' ? Math.PI / 4 : -Math.PI / 4;
        ctx.ellipse(x, y, r, Math.max(0.5, r * (tip === 'marker' ? 0.5 : 0.18)), angle, 0, Math.PI * 2);
      } else {
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }

  function spacing(width) {
    if (tip === 'pencil') return 0.65;
    if (tip === 'airbrush') return Math.max(1, width * 0.22);
    if (tip === 'soft' || tip === 'watercolor') return Math.max(0.75, width * 0.14);
    return Math.max(0.45, width * 0.085);
  }

  ctx.save();
  stamp(point.x, point.y, diameter(point.pressure));
  ctx.restore();
  distanceToStamp = spacing(diameter(point.pressure));
  return {
    opacity: styleOpacity[tip] ?? 1,
    add(next) {
      const dx = next.x - previous.x, dy = next.y - previous.y;
      const length = Math.hypot(dx, dy);
      if (!length) return;
      ctx.save();
      if (roundStroke) {
        ctx.lineCap = 'round';
        ctx.strokeStyle = pigment;
        ctx.lineWidth = diameter((previous.pressure + next.pressure) / 2);
        ctx.beginPath();
        ctx.moveTo(previous.x, previous.y);
        ctx.lineTo(next.x, next.y);
        ctx.stroke();
      } else {
        while (distanceToStamp <= length) {
          const t = distanceToStamp / length;
          const width = diameter(previous.pressure + (next.pressure - previous.pressure) * t);
          stamp(previous.x + dx * t, previous.y + dy * t, width);
          distanceToStamp += spacing(width);
        }
        distanceToStamp -= length;
      }
      ctx.restore();
      previous = next;
    },
    spray() {
      ctx.save();
      stamp(previous.x, previous.y, diameter(previous.pressure));
      ctx.restore();
    }
  };
}
