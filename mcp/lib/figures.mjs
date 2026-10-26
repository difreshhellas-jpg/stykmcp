// Figure presets, bone naming and the MCP angle convention.
//
// MCP angles are absolute bone directions in degrees on screen:
//   0 = pointing down, 90 = right, 180 = up, -90 = left.
// Native Pivot angles are absolute radians with 0 = right, PI/2 = down
// (y grows downwards), so native = PI/2 - deg·PI/180.
import {createBlueStartupPose} from '../../src/startup-blue-data.mjs';
import {defaultFigure} from '../../src/demo.mjs';

export const toNative = deg => Math.PI / 2 - deg * Math.PI / 180;
export const toDegrees = rad => wrap(90 - rad * 180 / Math.PI);
/** Wrap degrees to (-180, 180]. */
export function wrap(deg) { let d = ((deg + 180) % 360 + 360) % 360 - 180; if (d === -180) d = 180; return d; }
const round1 = value => Math.round(value * 10) / 10;

/** Canonical bone ids of the two-legged stick topology, in segment order. */
export const STICK_BONES = ['torso', 'head', 'arm_l', 'forearm_l', 'arm_r', 'forearm_r', 'thigh_l', 'shin_l', 'thigh_r', 'shin_r'];
const BLUE_NAMES = ['Torso', 'Head', 'Left upper arm', 'Left forearm', 'Right upper arm', 'Right forearm', 'Left thigh', 'Left lower leg', 'Right thigh', 'Right lower leg'];
export const LIMBS = {arm_l: ['arm_l', 'forearm_l'], arm_r: ['arm_r', 'forearm_r'], leg_l: ['thigh_l', 'shin_l'], leg_r: ['thigh_r', 'shin_r']};

const slug = text => String(text ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const parseColor = (color, fallback) => {
  if (color === undefined) return fallback;
  const match = /^#?([0-9a-f]{6})$/i.exec(String(color));
  if (!match) throw new Error(`Color must be "#rrggbb", got "${color}".`);
  const value = parseInt(match[1], 16);
  return [value >> 16 & 255, value >> 8 & 255, value & 255];
};
export const hexColor = rgb => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
export {parseColor};

/** Bone ids for a figure: STICK_BONES when its topology matches, else slugged names or s<id>. */
export function boneIds(figure) {
  const segments = figure.segments;
  const stick = segments.length === 10 && segments.every((s, i) => s.parent_id === [0, 1, 1, 3, 1, 5, 0, 7, 0, 9][i] && s.segment_id === i + 1);
  if (stick) return STICK_BONES;
  const used = new Set();
  return segments.map(s => { let id = slug(s.name) || `s${s.segment_id}`; if (used.has(id)) id = `s${s.segment_id}`; used.add(id); return id; });
}
export const isStick = figure => boneIds(figure) === STICK_BONES;

/** Resolve a bone reference (id, original name, slug or s<id>) to a segment index. */
export function boneIndex(figure, name) {
  const ids = boneIds(figure), key = slug(name);
  let index = ids.indexOf(key);
  if (index < 0) index = figure.segments.findIndex(s => slug(s.name) === key || `s${s.segment_id}` === key);
  if (index < 0) index = BLUE_NAMES.findIndex(n => slug(n) === key) >= 0 && ids === STICK_BONES ? BLUE_NAMES.findIndex(n => slug(n) === key) : -1;
  if (index < 0) throw new Error(`Unknown bone "${name}". Bones: ${ids.join(' ')}`);
  return index;
}

/** Forward kinematics in scene pixels: start/end point of every segment. */
export function jointPositions(figure, object) {
  const scale = object.scale ?? 1, byId = new Map(), out = [];
  const lengths = object.len_flag && object.lengths?.length === figure.segments.length ? object.lengths : null;
  figure.segments.forEach((segment, index) => {
    const start = segment.parent_id === 0 ? {x: object.root_x, y: object.root_y} : byId.get(segment.parent_id)?.end ?? {x: object.root_x, y: object.root_y};
    const length = (lengths ? lengths[index] : segment.length) * scale, angle = object.angles[index] ?? segment.angle_rad;
    const end = {x: start.x + length * Math.cos(angle), y: start.y + length * Math.sin(angle)};
    const entry = {start, end}; byId.set(segment.segment_id, entry); out.push(entry);
  });
  return out;
}
/** Distance from the origin down to the lowest joint (used to keep figures on the ground). */
export function lowestOffset(figure, object) {
  let lowest = 0;
  jointPositions(figure, object).forEach(({end}, i) => {
    const kind = figure.segments[i].segment_kind ?? '';
    // A circle segment's far end is the top of the head; its lowest point is nearer the neck.
    if (!kind.startsWith('circle')) lowest = Math.max(lowest, end.y - object.root_y);
  });
  return lowest;
}
export function bounds(figure, object) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const pad = Math.max(...figure.segments.map(s => s.thickness ?? 0), 0) * (object.scale ?? 1) / 2;
  for (const {start, end} of jointPositions(figure, object)) for (const p of [start, end]) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const index = figure.segments.findIndex(s => s.segment_kind === 'text'), text = index >= 0 && figure.text_assets?.[0]?.bounds;
  if (text) {
    const k = object.scale ?? 1, {start} = jointPositions(figure, object)[index];
    return [start.x, start.y - text.height * k, start.x + text.width * k, start.y].map(Math.round);
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad].map(Math.round);
}

/** Height of the origin above the feet in the standing pose: the anchor offset for stick figures. */
export function anchorOffset(figure) {
  if (!isStick(figure)) return 0;
  return lowestOffset(figure, {root_x: 0, root_y: 0, scale: 1, angles: STICK_BONES.map(bone => toNative(STAND[bone]))});
}

const segment = (id, parent, length, angle, thickness, color, extra = {}) => ({
  segment_id: id, parent_id: parent, length, angle_rad: angle, thickness, bend_rad: 0, primitive_code: 0, aux_code: 0, flags: 0,
  segment_type: 'line', segment_kind: 'line', color_rgb: [...color], transparency: 0, visible: true, z_order: id, ...extra});

/** Standing pose in MCP degrees for the stick topology (facing right). */
export const STAND = {torso: 180, head: 180, arm_l: 24, forearm_l: 10, arm_r: -24, forearm_r: -10, thigh_l: 12, shin_l: 3, thigh_r: -12, shin_r: -3};

export const PRESETS = {
  stick: {about: 'rounded stick figure (Blue), 10 bones, IK-ready', color: [13, 153, 255]},
  stick_thin: {about: 'classic thin Pivot stick figure, 10 bones', color: [43, 43, 43]},
  ball: {about: 'filled circle; size = diameter px', color: [240, 165, 71]},
  ground: {about: 'horizontal line; size = width px (default canvas width)', color: [60, 60, 60]},
};

/** A fresh figure definition for a preset. */
export function presetFigure(preset, figureTypeId, {color, size, canvasWidth = 960, name} = {}) {
  const info = PRESETS[preset];
  if (!info) throw new Error(`Unknown preset "${preset}". Presets: ${Object.keys(PRESETS).join(', ')}`);
  const rgb = parseColor(color, info.color);
  let figure;
  if (preset === 'stick' || preset === 'stick_thin') {
    figure = preset === 'stick' ? createBlueStartupPose().figure : defaultFigure();
    figure.segments.forEach((s, i) => { s.color_rgb = [...rgb]; s.name = BLUE_NAMES[i]; s.angle_rad = toNative(STAND[STICK_BONES[i]]); });
  } else if (preset === 'ball') {
    figure = {segments: [segment(1, 0, size ?? 40, -Math.PI / 2, 0, rgb, {primitive_code: 3, flags: 3, segment_type: 'circle', segment_kind: 'circleFill', name: 'Ball'})]};
  } else {
    figure = {segments: [segment(1, 0, size ?? canvasWidth, 0, 4, rgb, {name: 'Ground'})]};
  }
  return {polyfills: [], image_assets: [], text_assets: [], ...figure, figure_type_id: figureTypeId, name: name ?? preset,
    segment_count: figure.segments.length};
}

/** Compact one-line pose: bone=deg pairs. */
export function poseText(figure, object) {
  const ids = boneIds(figure);
  return ids.map((id, i) => `${id}=${round1(toDegrees(object.angles[i]))}`).join(' ');
}
