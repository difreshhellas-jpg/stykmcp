// Figure definitions for shapes, text and drawn paths. Every one is an ordinary
// Pivot figure, so pose_set (x, y, scale, turn), figure_update, effects, the
// camera and saving treat it like any other figure.
//
// Shapes: invisible spokes from the origin to each vertex carry the fill polygon;
// visible edges from vertex to vertex draw the stroke. Rotating every absolute
// angle by the same amount (pose_set turn) therefore rotates the shape rigidly.
// Paths: a chain of segments along the path; the origin is the path's start.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parse} from '../../vendor/text/opentype.mjs';
import {compileTextFigure} from '../../src/text-authoring.mjs';
import {parseColor} from './figures.mjs';

const fail = message => { throw new Error(message); };
const TAU = Math.PI * 2;
/** MCP direction (0 down, 90 right, 180 up) to a unit vector on screen. */
const dir = deg => [Math.sin(deg * Math.PI / 180), Math.cos(deg * Math.PI / 180)];
const alpha = opacity => { if (!(opacity >= 0 && opacity <= 1)) fail('opacity must be 0-1.'); return opacity; };

const seg = (id, parent, dx, dy, thickness, rgb, opacity, extra = {}) => ({
  segment_id: id, parent_id: parent, length: Math.hypot(dx, dy), angle_rad: Math.atan2(dy, dx), thickness, bend_rad: 0,
  primitive_code: 0, aux_code: 0, flags: 0, segment_type: 'line', segment_kind: 'line', color_rgb: [...rgb],
  transparency: Math.round((1 - opacity) * 255), visible: true, z_order: id, ...extra});

const ellipse = (w, h, n = 48) => Array.from({length: n}, (_, i) => [Math.cos(i / n * TAU) * w / 2, Math.sin(i / n * TAU) * h / 2]);
function rounded(w, h, radius) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2)), x = w / 2 - r, y = h / 2 - r;
  if (!r) return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  const out = [];
  for (const [cx, cy, a0] of [[x, -y, -90], [x, y, 0], [-x, y, 90], [-x, -y, 180]])
    for (let i = 0; i <= 6; i++) { const a = (a0 + i * 15) * Math.PI / 180; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  return out;
}
const star = (size, points, inner) => Array.from({length: points * 2}, (_, i) => {
  const r = (i % 2 ? inner : 1) * size / 2, a = -Math.PI / 2 + i * Math.PI / points;
  return [Math.cos(a) * r, Math.sin(a) * r];
});

/** Parts of each shape kind: {points, closed, fill?: 'fill'|'fill2'|'none'}. Sizes in px, centered on the origin. */
const KINDS = {
  rect: {about: 'w,h, radius (rounded corners)', parts: a => [{points: rounded(a.w, a.h, a.radius ?? 0), closed: true}]},
  ellipse: {about: 'w,h', parts: a => [{points: ellipse(a.w, a.h), closed: true}]},
  circle: {about: 'size = diameter', parts: a => [{points: ellipse(a.size, a.size), closed: true}]},
  ring: {about: 'size = diameter; outline only', parts: a => [{points: ellipse(a.size, a.size), closed: true, fill: 'none'}]},
  polygon: {about: 'points [[x,y],...] relative to x,y', parts: a => [{points: a.points, closed: true}]},
  line: {about: 'points [[x,y],...] relative to x,y; stroke only', parts: a => [{points: a.points, closed: false, fill: 'none'}]},
  star: {about: 'size, sides = number of tips (5), inner (0.45)', parts: a => [{points: star(a.size, a.sides ?? 5, a.inner ?? .45), closed: true}]},
  arrow: {about: 'w = length, h = head width; points right (use rotation)', parts: a => {
    const head = Math.min(a.w * .45, a.h), shaft = a.h * .38;
    return [{points: [[-a.w / 2, -shaft / 2], [a.w / 2 - head, -shaft / 2], [a.w / 2 - head, -a.h / 2], [a.w / 2, 0], [a.w / 2 - head, a.h / 2], [a.w / 2 - head, shaft / 2], [-a.w / 2, shaft / 2]], closed: true}];
  }},
  cursor: {about: 'mouse pointer; size = height; x,y = the tip', parts: a => {
    const k = a.size / 24;
    return [{points: [[0, 0], [0, 19], [4.5, 15], [7.5, 22], [10.5, 20.8], [7.5, 14], [13.5, 14]].map(([x, y]) => [x * k, y * k]), closed: true}];
  }},
  window: {about: 'app window: w,h; color2 = title bar (default darker)', parts: a => {
    const bar = Math.min(a.h * .3, Math.max(18, a.h * .12));
    return [{points: rounded(a.w, a.h, a.radius ?? 6), closed: true},
      {points: [[-a.w / 2, -a.h / 2], [a.w / 2, -a.h / 2], [a.w / 2, -a.h / 2 + bar], [-a.w / 2, -a.h / 2 + bar]], closed: false, fill: 'fill2', stroke: false}];
  }},
  folder: {about: 'folder icon: w,h; color2 = tab (default darker)', parts: a => {
    const tab = a.h * .18, x = a.w / 2, y = a.h / 2;
    return [{points: [[-x, -y], [-x * .2, -y], [0, -y + tab], [x, -y + tab], [x, y], [-x, y]], closed: true, fill: 'fill2'},
      {points: [[-x, -y + tab * 1.8], [x, -y + tab * 1.8], [x, y], [-x, y]], closed: true}];
  }},
};
export const SHAPE_KINDS = Object.keys(KINDS);
export const shapeHelp = () => Object.entries(KINDS).map(([k, v]) => `${k}: ${v.about}`).join('\n');

const darker = rgb => rgb.map(v => Math.round(v * .7));
const rotate = (points, deg) => {
  if (!deg) return points;
  const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
  return points.map(([x, y]) => [x * c - y * s, x * s + y * c]);
};

/** A shape figure. a: {kind, w, h, size, points, radius, sides, inner, fill, color2, stroke, width, opacity, rotation}. */
export function shapeFigure(a, figureTypeId, name) {
  const spec = KINDS[a.kind] ?? fail(`kind must be one of ${SHAPE_KINDS.join(', ')}.`);
  const need = {rect: ['w', 'h'], ellipse: ['w', 'h'], arrow: ['w', 'h'], window: ['w', 'h'], folder: ['w', 'h'], circle: ['size'], ring: ['size'], star: ['size'], cursor: ['size'], polygon: ['points'], line: ['points']}[a.kind];
  for (const key of need) if (a[key] === undefined) fail(`${a.kind} needs ${need.join(', ')}.`);
  if (a.points && (a.points.length < 2 || a.points.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)))) fail('points must be [[x,y],...] with at least 2 points.');
  const opacity = alpha(a.opacity ?? 1), fill = a.fill === 'none' ? null : parseColor(a.fill, [240, 240, 240]);
  const fill2 = parseColor(a.color2, darker(fill ?? parseColor(a.stroke, [60, 60, 60])));
  const width = a.width ?? (a.kind === 'line' || a.kind === 'ring' || !fill ? 4 : a.stroke ? 3 : 0);
  const stroke = parseColor(a.stroke, fill ? darker(fill) : [40, 40, 40]);
  const segments = [], polyfills = [];
  for (const part of spec.parts(a)) {
    const points = rotate(part.points, a.rotation), first = segments.length + 1;
    points.forEach(([x, y], i) => segments.push(seg(first + i, 0, x, y, 0, stroke, opacity, {visible: false, name: `v${first + i}`})));
    const color = part.fill === 'fill2' ? fill2 : part.fill === 'none' ? null : fill;
    if (color && points.length >= 3) polyfills.push({polyfill_id: polyfills.length + 1, segment_ids: points.map((_, i) => first + i), color_rgb: [...color], color_alpha: opacity, z_order: polyfills.length});
    if (width > 0 && part.stroke !== false) {
      const edges = part.closed ? points.length : points.length - 1;
      for (let i = 0; i < edges; i++) {
        const [x0, y0] = points[i], [x1, y1] = points[(i + 1) % points.length], id = segments.length + 1;
        segments.push(seg(id, first + i, x1 - x0, y1 - y0, width, stroke, opacity, {name: `e${id}`}));
      }
    }
  }
  return {figure_type_id: figureTypeId, name, segments, segment_count: segments.length, polyfills, image_assets: [], text_assets: [], _styk: {mcpKind: `shape:${a.kind}`, mcpColor: [...(fill ?? stroke)]}};
}

let fonts;
const FONT_FILES = ['Regular', 'Bold', 'Italic', 'BoldItalic'];
function font(bold, italic) {
  fonts ??= new Map();
  const style = Number(!!bold) | Number(!!italic) << 1;
  if (!fonts.has(style)) {
    const bytes = readFileSync(fileURLToPath(new URL(`../../vendor/text/NotoSans-${FONT_FILES[style]}.ttf`, import.meta.url)));
    fonts.set(style, parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  }
  return fonts.get(style);
}

/** A text figure (the app's own vector text) and the origin offset that puts x,y at the anchor. */
export function textFigure({text, size = 32, color, bold = false, italic = false, align = 'center', opacity = 1, outline = 0, outline_color}, figureTypeId, name) {
  const figure = compileTextFigure({text, name, fontSize: size, bold, italic, alignment: align, color: parseColor(color, [30, 30, 30]), opacity: alpha(opacity),
    outlineWidth: outline, outlineColor: parseColor(outline_color, [0, 0, 0]), figureTypeId}, font(bold, italic));
  figure._styk.mcpKind = 'text';
  const b = figure.text_assets[0].bounds;
  // The renderer puts the text box's lower-left corner at the text segment's start. An invisible lead
  // segment from the origin puts it there, so the origin (x,y) is the anchor: the align edge, vertical middle.
  const dx = -(align === 'left' ? 0 : align === 'right' ? b.width : b.width / 2), dy = b.height / 2;
  const glyphs = figure.segments[0];
  figure.segments = [seg(1, 0, dx, dy, 0, glyphs.color_rgb, 1, {visible: false, name: 'anchor'}), {...glyphs, segment_id: 2, parent_id: 1, z_order: 2}];
  figure.segment_count = 2;
  return {figure, box: [b.width, b.height], offset: [dx, dy]};
}

// ---------- paths ----------
function catmull(points, closed, steps = 8) {
  const n = points.length, get = i => points[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))], out = [];
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const [p0, p1, p2, p3] = [get(i - 1), get(i), get(i + 1), get(i + 2)];
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map(k => .5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
    }
  }
  out.push(closed ? [...points[0]] : [...points[n - 1]]);
  return out;
}
/** Resample a polyline to n+1 points evenly spaced by arc length. */
function resample(points, n) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const total = cum.at(-1), out = [];
  let j = 1;
  for (let k = 0; k <= n; k++) {
    const d = total * k / n;
    while (j < points.length - 1 && cum[j] < d) j++;
    const span = cum[j] - cum[j - 1] || 1, t = Math.min(1, Math.max(0, (d - cum[j - 1]) / span));
    out.push([0, 1].map(i => points[j - 1][i] + (points[j][i] - points[j - 1][i]) * t));
  }
  return {points: out, length: total};
}

/** Absolute canvas points of a path spec: points (+smooth, closed) or circle/arc/spiral/wave around x,y. */
export function pathPoints(a) {
  let points, closed = Boolean(a.closed);
  if (a.points) {
    if (a.points.length < 2 || a.points.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) fail('points must be [[x,y],...] with at least 2 points.');
    points = a.points.map(p => [...p]);
    if ((a.smooth ?? true) && points.length >= 3) points = catmull(points, closed);
    else if (closed) points.push([...points[0]]);
  } else {
    if (!a.shape) fail('path_draw needs points or shape (circle, arc, spiral, wave).');
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) fail(`${a.shape} needs x,y (its center${a.shape === 'wave' ? ' left end' : ''}).`);
    const r = a.radius ?? 80, start = a.start_angle ?? 180, n = 96;
    if (a.shape === 'circle' || a.shape === 'arc') {
      // sweep: + is clockwise on screen. MCP angles grow counterclockwise (0 down -> 90 right), hence the minus.
      const sweep = a.shape === 'circle' ? 360 : a.sweep ?? 180;
      points = Array.from({length: n + 1}, (_, i) => { const [dx, dy] = dir(start - sweep * i / n); return [a.x + dx * r, a.y + dy * r]; });
    } else if (a.shape === 'spiral') {
      const turns = a.turns ?? 2.5;
      points = Array.from({length: n * 2 + 1}, (_, i) => { const t = i / (n * 2), [dx, dy] = dir(start - 360 * turns * t); return [a.x + dx * r * t, a.y + dy * r * t]; });
    } else if (a.shape === 'wave') {
      const length = a.length ?? 300, waves = a.turns ?? 3, [ux, uy] = dir(a.start_angle ?? 90);
      points = Array.from({length: n + 1}, (_, i) => { const t = i / n, side = Math.sin(t * waves * TAU) * r * .5; return [a.x + ux * length * t - uy * side, a.y + uy * length * t + ux * side]; });
    } else fail('shape must be circle, arc, spiral or wave.');
  }
  return points;
}

/** A path figure: a chain of n segments with optional taper. Returns the figure and the resampled points. */
export function pathFigure(a, figureTypeId, name) {
  const raw = pathPoints(a);
  const total = resample(raw, 1).length;
  if (total < 1) fail('The path has no length.');
  const n = Math.max(2, Math.min(64, Math.round(total / 10)));
  const {points} = resample(raw, n);
  const opacity = alpha(a.opacity ?? 1), rgb = parseColor(a.color, [255, 107, 44]), width = a.width ?? 6;
  const segments = [];
  for (let i = 0; i < n; i++) {
    const t = (i + .5) / n, taper = a.taper ? .25 + .75 * Math.sin(Math.PI * t) ** .6 : 1;
    segments.push(seg(i + 1, i, points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1], Math.max(1, width * taper), rgb, opacity, {name: `p${i + 1}`}));
  }
  return {figure: {figure_type_id: figureTypeId, name, segments, segment_count: n, polyfills: [], image_assets: [], text_assets: [], _styk: {mcpKind: 'path'}}, points};
}

/** Visible window [from, to] (0-1 of the path's length): origin position and per-segment lengths. */
export function pathWindow(points, from, to) {
  const n = points.length - 1, a = Math.max(0, Math.min(1, from)) * n, b = Math.max(0, Math.min(1, to)) * n;
  const i = Math.min(n - 1, Math.floor(a)), f = a - i;
  const origin = [0, 1].map(k => points[i][k] + (points[i + 1][k] - points[i][k]) * f);
  const lengths = Array.from({length: n}, (_, k) => {
    const full = Math.hypot(points[k + 1][0] - points[k][0], points[k + 1][1] - points[k][1]);
    return full * Math.max(0, Math.min(k + 1, b) - Math.max(k, a));
  });
  return {x: origin[0], y: origin[1], lengths};
}
