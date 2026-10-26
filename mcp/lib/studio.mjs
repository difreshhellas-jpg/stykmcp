// The MCP tool layer's engine: one animation document, edited by compact
// operations. It reuses the app's own document model, loader, evaluator,
// validators, camera-motion and effect factories; rendering, saving and
// opening go through RenderHost. Frames are 1-based output frames here; the
// document stores 0-based ticks (one tick = one output frame).
import path from 'node:path';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {Editor} from '../../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../../src/demo.mjs';
import {evaluatedFrame, nativeTimeline} from '../../src/pivot/geometry.mjs';
import {validateScene} from '../../src/pivot/model.mjs';
import {setOrder, frameOrder} from '../../src/pivot/structure.mjs';
import {snapshotPoseObject} from '../../src/pose-snapshot.mjs';
import {createCameraMotion, validateCameraMotion, CAMERA_MOTION_TYPES, MOTION_PARAMETERS} from '../../src/camera-motion.mjs';
import {createVfxClip, validateVfxClips} from '../../src/vfx-clips.mjs';
import {VFX_REGISTRY, effectAvailable} from '../../src/vfx-registry.mjs';
import {easedProgress} from '../../src/keyframe-easing.mjs';
import {EASING_MODES} from './easing.mjs';
import {PRESETS, presetFigure, boneIds, boneIndex, isStick, toNative, toDegrees, wrap, jointPositions, lowestOffset, bounds, anchorOffset, parseColor, hexColor, LIMBS, poseText} from './figures.mjs';
import {MOVES, expandMove} from './moves.mjs';
import {shapeFigure, textFigure, pathFigure, pathWindow, shapeHelp} from './shapes.mjs';
import {encodeVideo, writeSequence, VIDEO_FORMATS} from './encode.mjs';

const clone = value => structuredClone(value);
const r1 = value => Math.round(value * 10) / 10;
const fail = message => { throw new Error(message); };
const int = (value, label, min = 1, max = 1e6) => {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label} must be an integer from ${min} to ${max}.`);
  return value;
};
const hexArgb = color => { const [r, g, b] = parseColor(color); return (0xff << 24 | r << 16 | g << 8 | b) >>> 0; };
const colorNumber = value => typeof value === 'string' && /^#?[0-9a-f]{6}$/i.test(value) ? parseInt(value.replace('#', ''), 16) : value;
// Authored-key markers. Pivot keyframes are global (each holds every figure and
// the camera), but agents think per figure: a key is "authored" for a figure or
// the camera only where a tool set it; every other key is re-derived from the
// authored keys around it after each edit, so channels never fight.
const AUTHORED = '_mcpKey';
const lerpAngle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const keyEasing = frame => frame._styk?.easing ?? {interpolation: 'linear'};
/** Recolor a figure. Shapes keep their two-tone look: main fill in the color, second fill and outline darker. */
function recolor(type, rgb) {
  const main = type._styk?.mcpColor, dark = rgb.map(v => Math.round(v * .7)), same = (a, b) => a && b && a.every((v, i) => v === b[i]);
  for (const s of type.segments) s.color_rgb = main && (type.polyfills?.length ?? 0) > 0 ? [...dark] : [...rgb];
  for (const p of type.polyfills ?? []) if (p.color_rgb) p.color_rgb = !main || same(p.color_rgb, main) ? [...rgb] : [...dark];
  if (main) type._styk = {...type._styk, mcpColor: [...rgb]};
}
const frameRange = list => {
  if (!list.length) return 'none';
  const parts = []; let a = list[0], b = a;
  for (const v of list.slice(1)) { if (v === b + 1) b = v; else { parts.push(a === b ? `${a}` : `${a}-${b}`); a = b = v; } }
  parts.push(a === b ? `${a}` : `${a}-${b}`);
  return parts.join(',');
};

export class Studio {
  constructor({host, historyLimit = 60} = {}) {
    this.host = host;
    this.historyLimit = historyLimit;
    this.editor = new Editor({demo: false, historyLimit: 1});
    this.undoStack = []; this.redoStack = [];
    this.revision = 0;
    this.newProject({});
  }
  get doc() { return this.editor.report; }
  get totalFrames() { return this.editor.totalTicks; }

  // ---------- document lifecycle ----------
  _load(document, name) {
    // The app's own loader normalizes and validates documents exactly as File → Open does.
    this.editor.load(document, name ?? document._styk?.name ?? 'Untitled animation');
    this.revision++;
  }
  /** Run one mutating operation with a single undo step; failures roll back. */
  mutate(fn) {
    const before = JSON.stringify(this.doc);
    try {
      const result = fn(this.doc);
      this._derive(this.doc);
      validateScene(this.doc);
      validateVfxClips(this.doc._styk?.vfxClips);
      if (this.doc._styk?.cameraMotion) validateCameraMotion(this.doc._styk.cameraMotion);
      this._load(this.doc);
      if (JSON.stringify(this.doc) !== before) {
        this.undoStack.push(before); this.redoStack = [];
        if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
      }
      return result;
    } catch (error) {
      this._load(JSON.parse(before));
      throw error;
    }
  }
  /** Re-derive every non-authored figure pose and camera from the authored keys around it. */
  _derive(doc) {
    const keys = this._rows(doc).map(row => ({tick: row.start, frame: doc.keyframes[row.index]}));
    const fill = (pick, isAuthored, assign) => {
      const authored = keys.filter(key => pick(key.frame) && isAuthored(key.frame));
      if (!authored.length) return;
      for (const key of keys) {
        const target = pick(key.frame);
        if (!target || isAuthored(key.frame)) continue;
        const next = authored.find(a => a.tick > key.tick), prev = authored.findLast(a => a.tick < key.tick);
        const a = prev ?? next, b = next ?? prev;
        const t = prev && next ? easedProgress(keyEasing(prev.frame), (key.tick - prev.tick) / (next.tick - prev.tick)) : 0;
        assign(target, pick(a.frame), pick(b.frame), t, key.frame);
      }
    };
    const uids = new Set(keys.flatMap(key => key.frame.objects.map(o => o.unique_id)));
    for (const uid of uids) {
      const pick = frame => frame.objects.find(o => o.unique_id === uid);
      fill(pick, frame => Boolean(pick(frame)?.[AUTHORED]), (object, a, b, t) => {
        object.root_x = a.root_x + (b.root_x - a.root_x) * t;
        object.root_y = a.root_y + (b.root_y - a.root_y) * t;
        object.scale = a.scale + (b.scale - a.scale) * t;
        object.angles = a.angles.map((angle, i) => lerpAngle(angle, b.angles[i] ?? angle, t));
        if (a.len_flag && a.lengths?.length) { object.len_flag = a.len_flag; object.lengths = a.lengths.map((l, i) => l + ((b.lengths?.[i] ?? l) - l) * t); }
      });
    }
    fill(frame => frame.camera, frame => Boolean(frame._styk?.mcpCamera), (camera, a, b, t) => {
      Object.assign(camera, {is_default: Boolean(a.is_default && b.is_default), x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
        scale: a.scale + (b.scale - a.scale) * t, angle_rad: lerpAngle(a.angle_rad ?? 0, b.angle_rad ?? 0, t)});
    });
  }
  _markCamera(frame, authored = true) {
    frame._styk = {...frame._styk};
    if (authored) frame._styk.mcpCamera = true; else delete frame._styk.mcpCamera;
  }
  undo(steps = 1) {
    let n = 0;
    for (; n < steps && this.undoStack.length; n++) { this.redoStack.push(JSON.stringify(this.doc)); this._load(JSON.parse(this.undoStack.pop())); }
    return `undid ${n}; ${this.undoStack.length} left`;
  }
  redo(steps = 1) {
    let n = 0;
    for (; n < steps && this.redoStack.length; n++) { this.undoStack.push(JSON.stringify(this.doc)); this._load(JSON.parse(this.redoStack.pop())); }
    return `redid ${n}; ${this.redoStack.length} left`;
  }

  newProject({width = 960, height = 540, fps = 24, background = '#ffffff', frames = 48, name = 'Untitled animation'}) {
    int(width, 'width', 16, 7680); int(height, 'height', 16, 7680); int(fps, 'fps', 1, 120); int(frames, 'frames', 1, 100000);
    const document = emptyDocument();
    document.canvas_width = width; document.canvas_height = height; document.fps = fps;
    document.figure_types = [];
    document.backgrounds = [{background_id: 1, kind: 2, color: hexArgb(background), name: 'Background'}];
    const first = {...createFrame([], 1), background_id: 1, _styk: {easing: {interpolation: 'linear'}, mcpCamera: true}};
    document.keyframes = [first];
    document._styk.name = name;
    this.undoStack = []; this.redoStack = [];
    this._load(document, name);
    if (frames > 1) this.mutate(doc => this._ensureKey(doc, frames - 1));
    this.undoStack = [];
    return `new ${width}x${height} ${fps}fps ${frames}f bg ${background}`;
  }
  async open(file) {
    const bytes = await readFile(file), ext = path.extname(file).toLowerCase();
    let document;
    if (ext === '.json') document = JSON.parse(bytes.toString('utf8'));
    else document = (await this.host.open(bytes, path.basename(file))).document;
    if (document.document && !document.keyframes) document = document.document;
    this.undoStack = []; this.redoStack = [];
    this._load(document, path.basename(file, ext));
    this._flattenLayerSheet();
    // Every key of a file someone authored is meaningful: keep it exactly.
    for (const frame of this.doc.keyframes) { this._markCamera(frame); for (const object of frame.objects) object[AUTHORED] = true; }
    return `opened ${path.basename(file)}: ${this._summaryLine()}`;
  }
  /** The MCP authors plain keyframes; drop an Advanced-timeline layer sheet by materializing its keys. */
  _flattenLayerSheet() {
    const sheet = this.doc._styk?.layerSheet;
    if (!sheet) return;
    const ticks = new Set([0, this.totalFrames - 1]);
    for (const track of Object.values(sheet.tracks ?? {})) for (const key of track.keys ?? []) if (Number.isInteger(key.tick ?? key.start)) ticks.add(key.tick ?? key.start);
    const sorted = [...ticks].filter(t => t >= 0 && t < this.totalFrames).sort((a, b) => a - b);
    const frames = sorted.map((tick, i) => {
      const rows = this.editor.timeline;
      let index = 0; while (index + 1 < rows.length && rows[index + 1].start <= tick) index++;
      const row = rows[index], source = evaluatedFrame(this.doc, index, row.count ? (tick - row.start) / row.count : 0, tick);
      return this._frameFrom(source, this.doc.keyframes[index], (sorted[i + 1] ?? tick + 1) - tick);
    });
    const document = clone(this.doc);
    document.keyframes = frames; delete document._styk.layerSheet;
    this._load(document);
  }
  async save(file, format) {
    const ext = (format ?? path.extname(file).slice(1)).toLowerCase();
    await mkdir(path.dirname(path.resolve(file)), {recursive: true});
    if (ext === 'json') await writeFile(file, JSON.stringify(this.doc));
    else if (['styk', 'piv', 'stk'].includes(ext)) {
      if (ext === 'stk' && this.doc.figure_types.length !== 1) fail('.stk holds one figure: remove the others or save .styk.');
      const bytes = await this.host.save(this.doc, this.revision, {format: ext, name: this.doc._styk?.name, figureTypeId: this.doc.figure_types[0]?.figure_type_id});
      await writeFile(file, bytes);
      this.editor.markSaved();
      return `saved ${path.resolve(file)} (${ext}, ${bytes.length} bytes)`;
    } else fail('Save as .styk (editable, StykAnimate), .piv (Pivot animation), .stk (Pivot figure) or .json.');
    return `saved ${path.resolve(file)} (json)`;
  }
  setProject({width, height, fps, background, frames, name}) {
    return this.mutate(doc => {
      if (width !== undefined || height !== undefined) { doc.canvas_width = int(width ?? doc.canvas_width, 'width', 16, 7680); doc.canvas_height = int(height ?? doc.canvas_height, 'height', 16, 7680); }
      if (fps !== undefined) doc.fps = int(fps, 'fps', 1, 120);
      if (name !== undefined) doc._styk.name = String(name).slice(0, 200);
      if (background !== undefined) {
        const color = hexArgb(background);
        let entry = doc.backgrounds.find(b => b.kind === 2 && b.color === color);
        if (!entry) { entry = {background_id: Math.max(0, ...doc.backgrounds.map(b => b.background_id)) + 1, kind: 2, color, name: background}; doc.backgrounds.push(entry); }
        for (const frame of doc.keyframes) { frame.background_id = entry.background_id; frame.background_id_b = 0; frame.background_mix = 0; }
      }
      if (frames !== undefined) this._setLength(doc, int(frames, 'frames', 1, 100000));
      return `project ${this._summaryLine()}`;
    });
  }

  // ---------- time ----------
  _rows(doc) { return nativeTimeline(doc); }
  _total(doc) { const last = this._rows(doc).at(-1); return last ? last.start + last.count : 0; }
  _keyIndex(doc, tick) { return this._rows(doc).findIndex(row => row.start === tick); }
  _frameFrom(source, base, duration, {authored = false} = {}) {
    const frame = {...clone({...base, objects: [], object_draw_order: [], object_draw_order_unique_ids: []}),
      objects: source.objects.map(object => {
        const copy = snapshotPoseObject(object);
        for (const key of Object.keys(copy)) if (key.startsWith('_runtime') || key === '_movieclipSample') delete copy[key];
        if (authored) copy[AUTHORED] = true; else delete copy[AUTHORED];
        return copy;
      }),
      camera: clone(source.camera ?? base.camera), duration_raw: duration};
    frame.objects.forEach((o, i) => { o.object_slot = i; });
    const byUid = new Map(frame.objects.map((o, i) => [o.unique_id, i]));
    const order = (base.object_draw_order_unique_ids ?? []).filter(uid => byUid.has(uid));
    for (const o of frame.objects) if (!order.includes(o.unique_id)) order.push(o.unique_id);
    frame.object_draw_order_unique_ids = order; frame.object_draw_order = order.map(uid => byUid.get(uid));
    frame._styk = {...frame._styk}; delete frame._styk.frameId;
    if (authored) frame._styk.mcpCamera = true; else delete frame._styk.mcpCamera;
    return frame;
  }
  /** Ensure a keyframe starts exactly at tick, preserving the motion around it. Returns its index. */
  _ensureKey(doc, tick) {
    const rows = this._rows(doc), last = rows.at(-1), total = last.start + last.count;
    const existing = rows.findIndex(row => row.start === tick);
    if (existing >= 0) return existing;
    if (tick >= total) {
      // Extend: the final key becomes a hold up to the new key.
      const lastFrame = doc.keyframes.at(-1);
      lastFrame.duration_raw = tick - last.start;
      const hold = this._frameFrom(lastFrame, lastFrame, 1);
      doc.keyframes.push(hold);
      return doc.keyframes.length - 1;
    }
    const index = rows.findIndex(row => row.start < tick && tick < row.start + Math.max(row.count, doc.keyframes[row.index].duration_raw));
    const row = rows[index], base = doc.keyframes[index];
    const source = evaluatedFrame(doc, index, (tick - row.start) / doc.keyframes[index].duration_raw, tick);
    const split = this._frameFrom(source, base, base.duration_raw - (tick - row.start));
    base.duration_raw = tick - row.start;
    doc.keyframes.splice(index + 1, 0, split);
    return index + 1;
  }
  _setLength(doc, frames) {
    const tick = frames - 1;
    this._ensureKey(doc, tick);
    const index = this._keyIndex(doc, tick);
    doc.keyframes.splice(index + 1);
    doc.keyframes[index].duration_raw = 1;
  }
  keys({action, frames = [], to, easing, count}) {
    return this.mutate(doc => {
      const ticks = frames.map(f => int(f, 'frame') - 1);
      if (action === 'add') { for (const t of ticks) this._ensureKey(doc, t); return `keys at ${this._keyList(doc)}`; }
      if (action === 'delete') {
        for (const t of [...ticks].sort((a, b) => b - a)) {
          const i = this._keyIndex(doc, t);
          if (i <= 0) { if (i === 0) fail('The first keyframe (frame 1) cannot be deleted.'); continue; }
          doc.keyframes[i - 1].duration_raw += doc.keyframes[i].duration_raw;
          doc.keyframes.splice(i, 1);
        }
        return `keys at ${this._keyList(doc)}`;
      }
      if (action === 'copy') {
        if (!ticks.length || to === undefined) fail('copy needs frames:[source] and to:<frame>.');
        const source = this._sampled(doc, ticks[0]), target = this._ensureKey(doc, int(to, 'to') - 1);
        const frame = doc.keyframes[target], copy = this._frameFrom(source, frame, frame.duration_raw, {authored: true});
        frame.objects = copy.objects; frame.camera = copy.camera; frame.object_draw_order = copy.object_draw_order; frame.object_draw_order_unique_ids = copy.object_draw_order_unique_ids;
        this._markCamera(frame);
        return `copied f${frames[0]} -> f${to}`;
      }
      if (action === 'easing') {
        if (!EASING_MODES.includes(easing)) fail(`easing must be one of ${EASING_MODES.join(', ')}.`);
        const targets = ticks.length ? ticks.map(t => this._ensureKey(doc, t)) : doc.keyframes.map((_, i) => i);
        for (const i of targets) doc.keyframes[i]._styk = {...doc.keyframes[i]._styk, easing: {interpolation: easing}};
        return `easing ${easing} on ${targets.length} key(s)`;
      }
      if (action === 'insert_time' || action === 'remove_time') {
        const at = ticks[0], n = int(count, 'count', 1, 100000);
        if (at === undefined) fail(`${action} needs frames:[at] and count.`);
        if (action === 'insert_time') {
          const i = this._ensureKey(doc, at);
          if (i === 0) fail('Insert time after frame 1.');
          doc.keyframes[i - 1].duration_raw += n;
        } else {
          this._ensureKey(doc, at);
          if (at + n < this._total(doc)) this._ensureKey(doc, at + n);
          const rows = this._rows(doc), keep = rows.filter(r => r.start < at || r.start >= at + n).map(r => doc.keyframes[r.index]);
          if (keep.length === rows.length) fail('Nothing to remove.');
          doc.keyframes = keep;
          // Re-chain durations: each surviving key lasts until the next survivor.
          const starts = rows.filter(r => r.start < at || r.start >= at + n).map(r => r.start < at ? r.start : r.start - n);
          doc.keyframes.forEach((frame, j) => { frame.duration_raw = j + 1 < starts.length ? starts[j + 1] - starts[j] : 1; });
        }
        return `length ${this._total(doc)}f; keys at ${this._keyList(doc)}`;
      }
      fail('action must be add, delete, copy, easing, insert_time or remove_time.');
    });
  }
  _keyList(doc) { return frameRange(this._rows(doc).map(r => r.start + 1)); }
  _sampled(doc, tick) {
    const rows = this._rows(doc);
    let index = 0; while (index + 1 < rows.length && rows[index + 1].start <= tick) index++;
    const row = rows[index];
    return evaluatedFrame(doc, index, row.count > 1 ? Math.min(1, (tick - row.start) / doc.keyframes[index].duration_raw) : 0, tick);
  }

  // ---------- figures ----------
  _figure(doc, ref) {
    const types = doc.figure_types;
    const objects = new Map(); for (const key of doc.keyframes) for (const o of key.objects) if (!objects.has(o.unique_id)) objects.set(o.unique_id, o);
    let object;
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) object = objects.get(Number(ref));
    else {
      const wanted = String(ref).toLowerCase();
      const type = types.find(t => String(t.name).toLowerCase() === wanted);
      if (type) object = [...objects.values()].find(o => o.figure_type_id === type.figure_type_id);
    }
    if (!object) fail(`No figure "${ref}". Figures: ${[...objects.values()].map(o => this._name(doc, o)).join(', ') || 'none'}`);
    const figure = types.find(t => t.figure_type_id === object.figure_type_id);
    return {uid: object.unique_id, figure, name: this._name(doc, object)};
  }
  _name(doc, object) {
    const type = doc.figure_types.find(t => t.figure_type_id === object.figure_type_id);
    const shared = doc.keyframes[0].objects.filter(o => o.figure_type_id === object.figure_type_id).length > 1;
    return shared || !type?.name ? `${object.unique_id}` : type.name;
  }
  _objectAt(doc, index, uid, required = true) {
    const object = doc.keyframes[index].objects.find(o => o.unique_id === uid);
    if (!object && required) fail(`That figure is not present at frame ${this._rows(doc)[index].start + 1}.`);
    return object;
  }
  _reorder(frame) {
    frame.objects.forEach((o, i) => { o.object_slot = i; });
    const uids = new Set(frame.objects.map(o => o.unique_id));
    const order = (frame.object_draw_order_unique_ids ?? []).filter(uid => uids.has(uid));
    for (const o of frame.objects) if (!order.includes(o.unique_id)) order.push(o.unique_id);
    const slots = new Map(frame.objects.map((o, i) => [o.unique_id, i]));
    frame.object_draw_order_unique_ids = order; frame.object_draw_order = order.map(uid => slots.get(uid));
  }
  async addFigure({preset, file, name, x, y, scale = 1, color, size, from = 1, to}) {
    let imported;
    if (file) {
      const bytes = await readFile(file);
      imported = (await this.host.open(bytes, path.basename(file))).document;
      if (!imported.figure_types?.length) fail('That file holds no figure.');
    }
    return this.mutate(doc => {
      const typeId = this._typeId(doc), label = this._label(doc, name, `${preset ?? 'figure'}${typeId}`);
      let figure, pose;
      if (imported) {
        figure = {...clone(imported.figure_types[0]), figure_type_id: typeId, name: label};
        const source = imported.keyframes?.[0]?.objects?.find(o => o.figure_type_id === imported.figure_types[0].figure_type_id);
        pose = source ? {angles: source.angles.slice(), lengths: source.lengths, len_flag: source.len_flag} : null;
        if (color) for (const s of figure.segments) s.color_rgb = parseColor(color);
      } else {
        figure = presetFigure(preset ?? 'stick', typeId, {color, size, canvasWidth: doc.canvas_width, name: label});
      }
      const anchor = anchorOffset(figure) * scale;
      const px = x ?? (preset === 'ground' ? 0 : doc.canvas_width / 2), py = y ?? (preset === 'ground' ? doc.canvas_height * .85 : doc.canvas_height * .8);
      const uid = this._place(doc, figure, {from, to, make: () => ({root_x: px, root_y: py - anchor, scale, ...(pose ? clone(pose) : {})})});
      return `added ${label} (uid ${uid}, ${figure.segments.length} bones) at ${Math.round(px)},${Math.round(py)}`;
    });
  }
  _typeId(doc) { return Math.max(0, ...doc.figure_types.map(t => t.figure_type_id)) + 1; }
  _label(doc, name, fallback) {
    const label = name ?? fallback;
    if (doc.figure_types.some(t => String(t.name).toLowerCase() === String(label).toLowerCase())) fail(`A figure named "${label}" exists; pick another name or use pose_set on it.`);
    return label;
  }
  /**
   * Add a figure type and one object of it, present from..to (1-based). make(tick) returns the
   * object's fields at each key; authored(tick) marks the keys it owns (default: only the first).
   */
  _place(doc, figure, {from = 1, to, make, authored}) {
    doc.figure_types.push(figure);
    const uid = Math.max(0, ...doc.keyframes.flatMap(k => k.objects.map(o => o.unique_id))) + 1;
    const first = int(from, 'from') - 1, last = to === undefined ? Infinity : int(to, 'to') - 1;
    if (last < first) fail('to must be at or after from.');
    authored ??= tick => tick === first;
    this._ensureKey(doc, first);
    if (Number.isFinite(last) && last + 1 < this._total(doc)) this._ensureKey(doc, last + 1);
    else if (Number.isFinite(last)) this._ensureKey(doc, last);
    for (const row of this._rows(doc)) {
      if (row.start < first || row.start > last) continue;
      const {root_x, root_y, ...fields} = make(row.start), object = createObject(figure, uid, root_x, root_y, fields);
      if (authored(row.start)) object[AUTHORED] = true;
      doc.keyframes[row.index].objects.push(object);
      this._reorder(doc.keyframes[row.index]);
    }
    return uid;
  }
  async addShape({kind, x, y, name, from = 1, to, ...shape}) {
    return this.mutate(doc => {
      const typeId = this._typeId(doc), label = this._label(doc, name, `${kind}${typeId}`);
      const figure = shapeFigure({kind, ...shape}, typeId, label);
      const px = x ?? doc.canvas_width / 2, py = y ?? doc.canvas_height / 2;
      this._place(doc, figure, {from, to, make: () => ({root_x: px, root_y: py})});
      return `added ${label} (${kind}) at ${Math.round(px)},${Math.round(py)}`;
    });
  }
  async addText({text, x, y, name, from = 1, to, ...style}) {
    return this.mutate(doc => {
      const typeId = this._typeId(doc), label = this._label(doc, name, `text${typeId}`);
      const {figure, box} = textFigure({text, ...style}, typeId, label);
      const px = x ?? doc.canvas_width / 2, py = y ?? doc.canvas_height / 2;
      this._place(doc, figure, {from, to, make: () => ({root_x: px, root_y: py})});
      return `added ${label} (text ${Math.round(box[0])}x${Math.round(box[1])}) at ${Math.round(px)},${Math.round(py)}`;
    });
  }
  /** Draw a stroke on over start..end, optionally hold, then erase (or travel as a comet). */
  async drawPath({name, start = 1, end, mode = 'draw', trail = .3, erase, erase_end, to, easing = 'ease-out', ...path}) {
    if (!EASING_MODES.includes(easing)) fail(`easing must be one of ${EASING_MODES.join(', ')}.`);
    return this.mutate(doc => {
      const first = int(start, 'start') - 1, last = int(end ?? start + 11, 'end') - 1;
      if (last <= first) fail('end must be after start.');
      if (last - first > 480) fail('Draw over at most 480 frames.');
      const typeId = this._typeId(doc), label = this._label(doc, name, `path${typeId}`);
      const {figure, points} = pathFigure(path, typeId, label);
      const ease = t => easedProgress({interpolation: easing}, Math.max(0, Math.min(1, t)));
      let window, keyed = tick => tick >= first && tick <= last, stop = to === undefined ? undefined : int(to, 'to') - 1;
      if (mode === 'comet') {
        if (!(trail > 0 && trail <= 1)) fail('trail must be in (0, 1].');
        window = tick => { const head = ease((tick - first) / (last - first)) * (1 + trail); return [head - trail, head]; };
        stop = last;
      } else if (mode === 'draw') {
        const e0 = erase === undefined ? undefined : int(erase, 'erase') - 1, e1 = e0 === undefined ? undefined : int(erase_end ?? erase + 7, 'erase_end') - 1;
        if (e0 !== undefined && (e0 <= last || e1 <= e0)) fail('erase must be after end, and erase_end after erase.');
        if (e0 !== undefined) { stop = e1; keyed = tick => (tick >= first && tick <= last) || (tick >= e0 && tick <= e1); }
        else if (stop !== undefined && stop < last) fail('to must be at or after end.');
        window = tick => [e0 !== undefined && tick >= e0 ? ease((tick - e0) / (e1 - e0)) : 0, ease((tick - first) / (last - first))];
      } else fail('mode must be draw or comet.');
      for (let tick = first; tick <= (stop ?? last); tick++) if (keyed(tick)) this._ensureKey(doc, tick);
      this._place(doc, figure, {from: start, to: stop === undefined ? undefined : stop + 1, authored: keyed, make: tick => {
        const [a, b] = window(keyed(tick) ? tick : last), view = pathWindow(points, a, b);
        return {root_x: view.x, root_y: view.y, len_flag: 1, lengths: view.lengths};
      }});
      const length = Math.round(points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0));
      return `${label}: ${mode} ${length}px path f${start}-${last + 1}${stop !== undefined ? `, gone after f${stop + 1}` : ', stays'}`;
    });
  }
  /** Copies of a figure that replay its motion with a delay and an offset (glitch clones, afterimages, crowds). */
  cloneFigure({figure: ref, count = 1, delay = 2, dx = 0, dy = 0, color, opacity, fade = false, from, to, order = 'back', name}) {
    return this.mutate(doc => {
      const {uid, figure: type, name: base} = this._figure(doc, ref);
      int(count, 'count', 1, 12); int(delay, 'delay', 0, 1000);
      const present = this._rows(doc).filter(r => this._objectAt(doc, r.index, uid, false));
      const first = int(from ?? present[0].start + 1, 'from') - 1, last = int(to ?? this._total(doc), 'to') - 1;
      const sourceKeys = present.filter(r => this._objectAt(doc, r.index, uid)[AUTHORED]).map(r => r.start);
      const added = [];
      for (let c = 1; c <= count; c++) {
        const shift = delay * c, ticks = new Set([first, last]);
        for (const t of sourceKeys) if (t + shift > first && t + shift < last) ticks.add(t + shift);
        // Sample the original before adding keys: a copy at tick shows the original at tick - shift.
        const poses = new Map([...ticks].map(tick => [tick, this._sampled(doc, Math.max(0, tick - shift)).objects.find(o => o.unique_id === uid)]));
        const typeId = this._typeId(doc), label = this._label(doc, name ? `${name}${c}` : undefined, `${base}_copy${c}`);
        const copy = {...clone(type), figure_type_id: typeId, name: label};
        const fadeTo = opacity ?? (fade ? 1 : undefined), alphaOf = fadeTo === undefined ? null : fade ? fadeTo * (1 - c / (count + 1)) : fadeTo;
        if (alphaOf !== null && !(alphaOf >= 0 && alphaOf <= 1)) fail('opacity must be 0-1.');
        const rgb = color === undefined ? null : parseColor(color);
        if (rgb) recolor(copy, rgb);
        for (const s of copy.segments) { if (alphaOf !== null) s.transparency = Math.round(255 - (255 - (s.transparency ?? 0)) * alphaOf); }
        for (const p of copy.polyfills ?? []) { if (alphaOf !== null) p.color_alpha = (p.color_alpha ?? 1) * alphaOf; }
        for (const tick of ticks) this._ensureKey(doc, tick);
        const id = this._place(doc, copy, {from: first + 1, to: last + 1, authored: tick => ticks.has(tick) && Boolean(poses.get(tick)), make: tick => {
          const pose = poses.get(tick) ?? poses.get(first);
          if (!pose) fail(`${base} is not present at frame ${tick - shift + 1}.`);
          const {unique_id, figure_type_id, object_slot, [AUTHORED]: _, ...fields} = snapshotPoseObject(pose);
          for (const key of Object.keys(fields)) if (key.startsWith('_runtime') || key === '_movieclipSample') delete fields[key];
          return {...clone(fields), root_x: pose.root_x + dx * c, root_y: pose.root_y + dy * c};
        }});
        for (const frame of doc.keyframes) {
          const ids = frameOrder(frame), at = ids.indexOf(id), anchor = ids.indexOf(uid);
          if (at < 0 || anchor < 0) continue;
          ids.splice(at, 1); ids.splice(order === 'front' ? ids.indexOf(uid) + 1 : ids.indexOf(uid), 0, id);
          setOrder(frame, ids);
        }
        added.push(label);
      }
      return `${base}: ${added.join(', ')} (delay ${delay}f, offset ${dx},${dy} each) f${first + 1}-${last + 1}`;
    });
  }
  removeFigure({figure}) {
    return this.mutate(doc => {
      const {uid, figure: type, name} = this._figure(doc, figure);
      for (const frame of doc.keyframes) { frame.objects = frame.objects.filter(o => o.unique_id !== uid); this._reorder(frame); }
      if (!doc.keyframes.some(k => k.objects.some(o => o.figure_type_id === type.figure_type_id))) doc.figure_types = doc.figure_types.filter(t => t !== type);
      if (doc._styk?.vfxClips) doc._styk.vfxClips = {...doc._styk.vfxClips, clips: doc._styk.vfxClips.clips.filter(c => c.target.uid !== uid)};
      if (doc._styk?.cameraMotion) doc._styk.cameraMotion = {...doc._styk.cameraMotion, clips: doc._styk.cameraMotion.clips.filter(c => !c.targets?.some(t => t.uid === uid))};
      return `removed ${name}`;
    });
  }
  updateFigure({figure, rename, color, order}) {
    return this.mutate(doc => {
      const {uid, figure: type, name} = this._figure(doc, figure), out = [];
      if (rename) {
        if (doc.figure_types.some(t => t !== type && String(t.name).toLowerCase() === rename.toLowerCase())) fail(`"${rename}" is taken.`);
        type.name = rename; out.push(`renamed ${rename}`);
      }
      if (color) { recolor(type, parseColor(color)); out.push(`color ${color}`); }
      if (order) {
        for (const frame of doc.keyframes) {
          const ids = frameOrder(frame), i = ids.indexOf(uid);
          if (i < 0) continue;
          ids.splice(i, 1);
          if (order === 'front') ids.push(uid); else if (order === 'back') ids.unshift(uid); else fail('order must be front or back.');
          setOrder(frame, ids);
        }
        out.push(`moved to ${order}`);
      }
      return `${name}: ${out.join(', ') || 'unchanged'}`;
    });
  }

  // ---------- poses ----------
  _applyPose(figure, object, {angles, bend, x, y, dx, dy, scale, turn, flip, ground}) {
    if (scale !== undefined) { if (!(scale > 0 && scale <= 50)) fail('scale must be in (0, 50].'); const anchor = anchorOffset(figure); object.root_y += anchor * (object.scale - scale); object.scale = scale; }
    if (flip) object.angles = object.angles.map(a => toNative(-toDegrees(a)));
    if (turn) object.angles = object.angles.map(a => toNative(toDegrees(a) + turn));
    for (const [bone, deg] of Object.entries(angles ?? {})) {
      if (!Number.isFinite(deg)) fail(`Angle for ${bone} must be a number of degrees.`);
      object.angles[boneIndex(figure, bone)] = toNative(deg);
    }
    for (const [bone, delta] of Object.entries(bend ?? {})) {
      const index = boneIndex(figure, bone), root = figure.segments[index].segment_id, subtree = new Set([root]);
      for (const s of figure.segments) if (subtree.has(s.parent_id)) subtree.add(s.segment_id);
      figure.segments.forEach((s, i) => { if (subtree.has(s.segment_id)) object.angles[i] = toNative(toDegrees(object.angles[i]) + delta); });
    }
    const anchor = anchorOffset(figure) * object.scale;
    if (x !== undefined) object.root_x = x;
    if (y !== undefined) object.root_y = y - anchor;
    if (dx) object.root_x += dx;
    if (dy) object.root_y += dy;
    if (ground !== undefined) object.root_y = ground - lowestOffset(figure, object);
  }
  pose(args) {
    return this.mutate(doc => {
      const {uid, figure, name} = this._figure(doc, args.figure);
      const frames = args.frames ?? [args.frame ?? 1];
      for (const f of frames) {
        const index = this._ensureKey(doc, int(f, 'frame') - 1);
        const object = this._objectAt(doc, index, uid);
        this._applyPose(figure, object, args); object[AUTHORED] = true;
        if (args.easing) this._setEasing(doc, index, args.easing);
      }
      const object = this._objectAt(doc, this._keyIndex(doc, frames.at(-1) - 1), uid);
      return `${name} f${frameRange(frames)}: at ${this._anchorText(figure, object)}`;
    });
  }
  _setEasing(doc, index, easing) {
    if (!EASING_MODES.includes(easing)) fail(`easing must be one of ${EASING_MODES.join(', ')}.`);
    doc.keyframes[index]._styk = {...doc.keyframes[index]._styk, easing: {interpolation: easing}};
  }
  _anchorText(figure, object) {
    return `${Math.round(object.root_x)},${Math.round(object.root_y + anchorOffset(figure) * object.scale)}`;
  }
  reach({figure: ref, limb, frame = 1, x, y, bend = 'auto'}) {
    return this.mutate(doc => {
      const {uid, figure, name} = this._figure(doc, ref);
      const bones = LIMBS[limb] ?? fail(`limb must be one of ${Object.keys(LIMBS).join(', ')}.`);
      if (!isStick(figure)) fail('ik_reach needs a stick-topology figure.');
      const index = this._ensureKey(doc, int(frame, 'frame') - 1), object = this._objectAt(doc, index, uid);
      const [a, b] = bones.map(bone => boneIndex(figure, bone)), joints = jointPositions(figure, object);
      const base = joints[a].start, l1 = figure.segments[a].length * object.scale, l2 = figure.segments[b].length * object.scale;
      const tx = x - base.x, ty = y - base.y, reach = Math.hypot(tx, ty), d = Math.min(Math.max(reach, Math.abs(l1 - l2) + 1e-6), l1 + l2 - 1e-6);
      const toTarget = Math.atan2(ty, tx), inner = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
      // Keep the current bend side unless asked: sign of the cross product of the two bones.
      const current = Math.sign(Math.sin(object.angles[b] - object.angles[a])) || 1;
      const side = bend === 'auto' ? -current : bend === 'cw' ? -1 : 1;
      const upper = toTarget + side * inner;
      const elbow = {x: base.x + l1 * Math.cos(upper), y: base.y + l1 * Math.sin(upper)};
      const target = {x: base.x + d * Math.cos(toTarget), y: base.y + d * Math.sin(toTarget)};
      object.angles[a] = upper; object.angles[b] = Math.atan2(target.y - elbow.y, target.x - elbow.x); object[AUTHORED] = true;
      const hit = Math.hypot(target.x - tx - base.x, target.y - ty - base.y);
      return `${name} ${limb} f${frame} -> ${Math.round(target.x)},${Math.round(target.y)}${hit > 1 ? ` (out of reach by ${Math.round(hit)}px)` : ''}`;
    });
  }
  move({figure: ref, move, start = 1, ...params}) {
    return this.mutate(doc => {
      const {uid, figure, name} = this._figure(doc, ref);
      if (!isStick(figure)) fail(`Moves need a stick-topology figure (${name} is not).`);
      const expanded = expandMove(move, params), startTick = int(start, 'start') - 1, endTick = startTick + expanded.duration - 1;
      const before = this._sampled(doc, startTick).objects.find(o => o.unique_id === uid) ?? fail(`${name} is not present at frame ${start}.`);
      const groundY = before.root_y + lowestOffset(figure, before), baseX = before.root_x, scale = before.scale ?? 1;
      const oldEnd = endTick < this._total(doc) ? this._sampled(doc, endTick).objects.find(o => o.unique_id === uid) : null;
      const placed = new Map();
      for (const key of expanded.keys) {
        const tick = startTick + key.offset, index = this._ensureKey(doc, tick), object = this._objectAt(doc, index, uid);
        object.angles = boneIds(figure).map(bone => toNative(key.pose[bone]));
        object.root_x = baseX + key.dx * scale;
        object.root_y = groundY - lowestOffset(figure, object) - key.lift * scale;
        this._setEasing(doc, index, params.easing ?? 'auto');
        object[AUTHORED] = true;
        placed.set(tick, clone(object));
      }
      // The move owns its range: other keys of this figure inside it are re-derived from the move.
      const moveTicks = [...placed.keys()].sort((a, b) => a - b);
      for (const row of this._rows(doc)) {
        if (row.start <= startTick || row.start >= endTick || placed.has(row.start)) continue;
        const object = this._objectAt(doc, row.index, uid, false);
        if (object) delete object[AUTHORED];
      }
      // Later keys keep their poses but carry the move's displacement, so moves chain in any order.
      const final = placed.get(moveTicks.at(-1));
      if (oldEnd) {
        const shiftX = final.root_x - oldEnd.root_x, shiftY = final.root_y - oldEnd.root_y;
        for (const row of this._rows(doc)) if (row.start > endTick) {
          const object = this._objectAt(doc, row.index, uid, false);
          if (object?.[AUTHORED]) { object.root_x += shiftX; object.root_y += shiftY; }
        }
      }
      const beat = expanded.beat ? `, ${expanded.beat.name} f${startTick + expanded.beat.offset + 1}` : '';
      return `${name} ${move} f${start}-${endTick + 1} (${expanded.keys.length} keys)${beat}, ends at ${this._anchorText(figure, final)}`;
    });
  }

  // ---------- camera ----------
  camera({frame = 1, frames, x, y, zoom, rotation, easing, reset}) {
    return this.mutate(doc => {
      const list = frames ?? [frame];
      for (const f of list) {
        const index = this._ensureKey(doc, int(f, 'frame') - 1), cam = doc.keyframes[index].camera ??= {is_default: true, x: 0, y: 0, scale: 1, angle_rad: 0};
        if (reset) Object.assign(cam, {is_default: true, x: 0, y: 0, scale: 1, angle_rad: 0});
        if (x !== undefined) cam.x = x - doc.canvas_width / 2;
        if (y !== undefined) cam.y = y - doc.canvas_height / 2;
        if (zoom !== undefined) { if (!(zoom >= .05 && zoom <= 50)) fail('zoom must be 0.05-50.'); cam.scale = 1 / zoom; }
        if (rotation !== undefined) cam.angle_rad = rotation * Math.PI / 180;
        if (!reset) cam.is_default = false;
        this._markCamera(doc.keyframes[index]);
        if (easing) this._setEasing(doc, index, easing);
      }
      const cam = doc.keyframes[this._keyIndex(doc, list.at(-1) - 1)].camera;
      return `camera f${frameRange(list)}: center ${Math.round(cam.x + doc.canvas_width / 2)},${Math.round(cam.y + doc.canvas_height / 2)} zoom ${r1(1 / cam.scale)} rot ${r1(cam.angle_rad * 180 / Math.PI)}`;
    });
  }
  cameraFx({preset, start, end, figure, x, y, zoom = 1.6, ramp = 3, params = {}}) {
    const startTick = int(start, 'start') - 1, endTick = int(end ?? start + (preset === 'impact' ? 11 : 23), 'end') - 1;
    if (endTick <= startTick) fail('end must be after start.');
    if (preset === 'punch_in' || preset === 'zoom') {
      return this.mutate(doc => {
        let cx = x, cy = y;
        if (figure !== undefined) {
          // Frame the figure's whole action during the hold, not just its first pose.
          const {uid, figure: type} = this._figure(doc, figure), box = [Infinity, Infinity, -Infinity, -Infinity];
          for (let tick = Math.min(startTick + ramp, endTick); tick <= endTick && tick < this._total(doc); tick++) {
            const object = this._sampled(doc, tick).objects.find(o => o.unique_id === uid);
            if (!object) continue;
            const [x0, y0, x1, y1] = bounds(type, object);
            box[0] = Math.min(box[0], x0); box[1] = Math.min(box[1], y0); box[2] = Math.max(box[2], x1); box[3] = Math.max(box[3], y1);
          }
          if (!Number.isFinite(box[0])) fail('That figure is not present then.');
          cx ??= (box[0] + box[2]) / 2; cy ??= (box[1] + box[3]) / 2;
        }
        const before = clone(this._sampled(doc, startTick).camera);
        const set = (tick, cam) => { const i = this._ensureKey(doc, tick); doc.keyframes[i].camera = cam; this._markCamera(doc.keyframes[i]); return i; };
        for (const row of this._rows(doc)) if (row.start > startTick && row.start < endTick) this._markCamera(doc.keyframes[row.index], false);
        const zoomed = {is_default: false, x: (cx ?? doc.canvas_width / 2) - doc.canvas_width / 2, y: (cy ?? doc.canvas_height / 2) - doc.canvas_height / 2, scale: 1 / zoom, angle_rad: before.angle_rad ?? 0};
        this._setEasing(doc, set(startTick, {...before}), 'ease-out');
        set(Math.min(startTick + ramp, endTick), {...zoomed});
        if (preset === 'punch_in') { set(Math.max(startTick + ramp, endTick - 1), {...zoomed}); set(endTick, {...before}); }
        return `camera ${preset} f${start}-${endTick + 1} zoom ${zoom}`;
      });
    }
    if (!Object.hasOwn(CAMERA_MOTION_TYPES, preset)) fail(`preset must be punch_in, zoom or one of ${Object.keys(CAMERA_MOTION_TYPES).join(', ')}.`);
    return this.mutate(doc => {
      const targets = preset === 'follow' ? [{uid: this._figure(doc, figure ?? fail('follow needs figure.')).uid, weight: 1}] : undefined;
      const id = `motion-${(doc._styk.cameraMotion?.clips.length ?? 0) + 1}-${Date.now().toString(36)}`;
      const clip = createCameraMotion(preset, id, startTick, endTick - startTick + 1, {targets});
      for (const [key, value] of Object.entries(params)) {
        const name = key === 'intensity' ? 'strength' : key;
        if (!(name in clip.params)) fail(`${preset} params: ${Object.keys(clip.params).join(', ')} (or intensity).`);
        clip.params[name] = value;
      }
      if (this._total(doc) < endTick + 1) this._ensureKey(doc, endTick);
      doc._styk.cameraMotion = {version: 1, clips: [...(doc._styk.cameraMotion?.clips ?? []), clip]};
      return `camera fx ${id}: ${preset} f${start}-${endTick + 1}`;
    });
  }

  // ---------- effects ----------
  effect({kind, target = 'scene', start = 1, end, params = {}, fade_in = 0, fade_out = 0}) {
    if (!VFX_REGISTRY[kind]) fail(`Unknown effect "${kind}". See help topic "effects".`);
    return this.mutate(doc => {
      const scene = target === 'scene';
      if (!effectAvailable(kind, scene)) fail(`${kind} cannot target ${scene ? 'the scene' : 'a figure'}.`);
      const owner = scene ? {kind: 'scene'} : {kind: 'figure', uid: this._figure(doc, target).uid};
      const startTick = int(start, 'start') - 1, duration = end === undefined ? null : int(end, 'end') - startTick;
      if (duration !== null && duration < 1) fail('end must be at or after start.');
      const count = doc._styk.vfxClips?.clips.length ?? 0, id = `fx-${count + 1}-${Date.now().toString(36)}`;
      const clip = createVfxClip(owner, kind, id, `${id}-e`, {start: startTick, duration});
      clip.fadeIn = int(fade_in, 'fade_in', 0); clip.fadeOut = int(fade_out, 'fade_out', 0);
      const known = VFX_REGISTRY[kind].params;
      for (const [key, value] of Object.entries(params)) {
        if (!known[key]) fail(`${kind} params: ${Object.keys(known).join(', ')}.`);
        clip.effects[0].params[key] = known[key].type === 'color' ? colorNumber(value) : value;
      }
      if (duration !== null && this._total(doc) < startTick + duration) this._ensureKey(doc, startTick + duration - 1);
      doc._styk.vfxClips = {version: 1, clips: [...(doc._styk.vfxClips?.clips ?? []), clip]};
      return `effect ${id}: ${kind} on ${scene ? 'scene' : target} f${start}-${duration === null ? 'end' : startTick + duration}`;
    });
  }
  removeFx({id}) {
    return this.mutate(doc => {
      const motion = doc._styk.cameraMotion?.clips ?? [], vfx = doc._styk.vfxClips?.clips ?? [];
      if (id === 'all') { delete doc._styk.cameraMotion; delete doc._styk.vfxClips; return `removed ${motion.length + vfx.length} fx`; }
      if (motion.some(c => c.id === id)) doc._styk.cameraMotion = {version: 1, clips: motion.filter(c => c.id !== id)};
      else if (vfx.some(c => c.id === id)) doc._styk.vfxClips = {version: 1, clips: vfx.filter(c => c.id !== id)};
      else fail(`No fx "${id}". Ids: ${[...motion, ...vfx].map(c => c.id).join(', ') || 'none'}`);
      return `removed ${id}`;
    });
  }

  // ---------- reading ----------
  _summaryLine() {
    const doc = this.doc, n = this._total(doc), bg = doc.backgrounds?.find(b => b.background_id === doc.keyframes[0].background_id);
    return `${doc.canvas_width}x${doc.canvas_height} ${doc.fps}fps ${n}f (${r1(n / doc.fps)}s), ${doc.keyframes.length} keys, ${doc.keyframes[0].objects.length} figures${bg?.kind === 2 ? `, bg #${(bg.color & 0xffffff).toString(16).padStart(6, '0')}` : ''}`;
  }
  describe({frame, poses = false} = {}) {
    const doc = this.doc, lines = [this._summaryLine(), `keys: ${this._keyList(doc)}`];
    const tick = frame ? int(frame, 'frame', 1, this.totalFrames) - 1 : 0, sampled = this._sampled(doc, tick), topologies = new Map();
    for (const object of sampled.objects) {
      const figure = doc.figure_types.find(t => t.figure_type_id === object.figure_type_id);
      const present = this._rows(doc).filter(r => doc.keyframes[r.index].objects.some(o => o.unique_id === object.unique_id));
      const kind = figure._styk?.mcpKind ?? (isStick(figure) ? 'stick' : `${figure.segments.length} bones`);
      const color = hexColor(figure._styk?.mcpColor ?? figure.polyfills?.[0]?.color_rgb ?? figure.segments.find(s => s.visible !== false)?.color_rgb ?? [0, 0, 0]);
      let line = `- ${this._name(doc, object)} (uid ${object.unique_id}, ${kind}, ${color}) at ${this._anchorText(figure, object)} scale ${r1(object.scale)} box ${bounds(figure, object).join(',')}`;
      if (present.length !== doc.keyframes.length) line += ` keys ${frameRange(present.map(r => r.start + 1))}`;
      lines.push(line);
      if (poses) lines.push(`  ${poseText(figure, object)}`);
      if (!isStick(figure) && !figure._styk?.mcpKind && figure.segments.length > 1) topologies.set(boneIds(figure).join(' '), true);
    }
    if (doc.keyframes[0].objects.some(o => isStick(doc.figure_types.find(t => t.figure_type_id === o.figure_type_id)))) lines.push('stick bones: torso head arm_l forearm_l arm_r forearm_r thigh_l shin_l thigh_r shin_r');
    for (const topology of topologies.keys()) lines.push(`bones: ${topology}`);
    const cam = sampled.camera;
    if (cam && !cam.is_default) lines.push(`camera@f${tick + 1}: center ${Math.round(cam.x + doc.canvas_width / 2)},${Math.round(cam.y + doc.canvas_height / 2)} zoom ${r1(1 / cam.scale)}`);
    for (const c of doc._styk?.cameraMotion?.clips ?? []) lines.push(`fx ${c.id}: camera ${c.type} f${c.start + 1}-${c.start + c.duration}`);
    const nameOf = uid => { const object = doc.keyframes.flatMap(k => k.objects).find(o => o.unique_id === uid); return object ? this._name(doc, object) : uid; };
    for (const c of doc._styk?.vfxClips?.clips ?? []) lines.push(`fx ${c.id}: ${c.effects.map(e => e.type).join('+')} on ${c.target.kind === 'scene' ? 'scene' : nameOf(c.target.uid)} f${c.start + 1}-${c.duration === null ? 'end' : c.start + c.duration}`);
    lines.push(`undo ${this.undoStack.length}, redo ${this.redoStack.length}`);
    return lines.join('\n');
  }

  _ticks({frames, start = 1, end, count, fps}) {
    const total = this.totalFrames, last = Math.min(int(end ?? total, 'end'), total), first = int(start, 'start');
    if (first > last) fail(`start must be <= end (animation has ${total} frames).`);
    if (frames?.length) return frames.map(f => int(f, 'frame', 1, total) - 1);
    if (fps && fps !== this.doc.fps) {
      const seconds = (last - first + 1) / this.doc.fps, n = Math.max(1, Math.round(seconds * fps));
      return Array.from({length: n}, (_, i) => first - 1 + Math.min(last - first, Math.floor(i * this.doc.fps / fps)));
    }
    if (count) { const n = Math.min(count, last - first + 1); return Array.from({length: n}, (_, i) => first - 1 + Math.round(i * (last - first) / Math.max(1, n - 1))); }
    return Array.from({length: last - first + 1}, (_, i) => first - 1 + i);
  }
  _size(width) {
    const doc = this.doc, w = Math.round(width ?? doc.canvas_width), h = Math.max(1, Math.round(w * doc.canvas_height / doc.canvas_width));
    int(w, 'width', 8, 7680);
    return {width: w, height: h};
  }
  async preview({frames, count = 8, start, end, width = 160, columns = 4, file}) {
    const ticks = this._ticks({frames, start, end, count: frames?.length ? undefined : count});
    if (ticks.length > 48) fail('Preview at most 48 frames; export for more.');
    const cell = Math.round(width), {width: w, height: h} = this._size(Math.min(this.doc.canvas_width, cell * 2));
    const cols = Math.max(1, Math.min(columns, ticks.length));
    if (cell * cols > 1280) fail('Preview sheet would exceed 1280px wide; lower width or columns.');
    const png = ticks.length === 1
      ? (await this.host.frames(this.doc, this.revision, {ticks, ...this._size(cell)}))[0]
      : await this.host.sheet(this.doc, this.revision, {ticks, width: w, height: h, cellWidth: cell, columns: cols});
    if (file) { await mkdir(path.dirname(path.resolve(file)), {recursive: true}); await writeFile(file, png); }
    return {png, text: `preview f${frameRange(ticks.map(t => t + 1))}${file ? ` saved ${path.resolve(file)}` : ''}`};
  }
  async export({file, format, start, end, fps, width, alpha = false}) {
    format = (format ?? path.extname(file).slice(1)).toLowerCase();
    if (format === 'png' || format === 'png_sequence') format = 'png';
    if (![...VIDEO_FORMATS, 'png'].includes(format)) fail(`format must be mp4, webm, gif or png (sequence).`);
    const outFps = fps ?? this.doc.fps, ticks = this._ticks({start, end, fps: outFps}), size = this._size(width);
    if (format === 'mp4' && alpha) fail('mp4 has no transparency; use webm or png.');
    const doc = this.doc, revision = this.revision, host = this.host, batch = 12;
    async function* frames() {
      for (let i = 0; i < ticks.length; i += batch)
        yield* await host.frames(doc, revision, {ticks: ticks.slice(i, i + batch), ...size, alpha: alpha && format !== 'gif'});
    }
    const target = path.resolve(file);
    await mkdir(format === 'png' ? target : path.dirname(target), {recursive: true});
    if (format === 'png') await writeSequence({dir: target, frames: frames()});
    else await encodeVideo({format, file: target, fps: outFps, frames: frames()});
    return `exported ${target} (${format}, ${size.width}x${size.height}, ${ticks.length}f @${outFps}fps, ${r1(ticks.length / outFps)}s)`;
  }
}

export const HELP = {
  basics: `Frames are 1-based output frames; the clip length is "frames". Positions are canvas pixels, y grows down.
Stick figure position = the point between its feet when standing (hip is above it); other figures use their origin.
Angles: absolute bone direction in degrees: 0 down, 90 right, 180 up, -90 left. pose_set "bend" rotates a bone and everything attached to it by a delta.
Every edit at a frame creates a keyframe there (motion around it is preserved); between keys values interpolate with the key's easing.
Typical clip: project_new -> shape_add/text_add (set) -> figure_add -> move_apply (one or more, in time order) -> camera_fx/effect_add -> preview -> export. Use batch to send many ops in one call.
move_apply reports the move's key moment (impact/apex/lands frame): time camera_fx and effects to it. Default move lengths: see help moves.`,
  moves: () => Object.entries(MOVES).map(([name, m]) => `${name}: ${m.about}; default ${m.frames}f${m.per ? ` per ${m.per}` : ''}; defaults ${JSON.stringify(m.defaults)}`).join('\n') +
    '\nAll moves: start, speed (1=normal, 2=twice as fast), frames (override duration), direction (right|left), intensity (0.5 subtle .. 1.5 big), easing. Moves need stick figures; later keys of the figure shift with the move so moves chain.',
  presets: () => Object.entries(PRESETS).map(([name, p]) => `${name}: ${p.about}`).join('\n') + '\nfigure_add file=<path.stk|.stkz|.styk> imports the first figure of a file.',
  shapes: () => `shape_add kinds (sizes px, x,y = center; fill "none" = outline only; stroke/width = outline; color2 = second color):
${shapeHelp()}
text_add: text (\\n for lines), size px, align left|center|right (x = that edge), bold, italic, outline px.
path_draw: draws a stroke on from start to end and keeps it; erase=<frame> wipes it from its start; mode comet = a streak (trail = 0-1 of the path) that travels and vanishes. taper=true for a brush look.
figure_clone: count copies, copy k shows the figure delay*k frames late, offset dx*k,dy*k; fade or opacity, color.
All of these are figures: pose_set x,y,scale,turn moves them, figure_update recolors (one color), effect_add targets them by name, from/to limit when they show.`,
  camera: () => `camera_set: center x,y, zoom (2 = 2x closer), rotation deg, at frame(s).
camera_fx presets: punch_in (quick zoom to a figure or x,y then back at end; zoom, ramp frames), zoom (zoom and stay), ${Object.entries(CAMERA_MOTION_TYPES).map(([k, v]) => `${k} (${v})`).join(', ')}.
camera_fx params for native presets: intensity, ${Object.keys(MOTION_PARAMETERS).join(', ')}.`,
  effects: () => Object.entries(VFX_REGISTRY).map(([k, v]) => `${k}${v.generator ? '*' : ''}: ${Object.keys(v.params).filter(p => !v.params[p].advanced).join(',')}`).join('\n') +
    '\n* = generator (particles/explosion/smoke/...). target = figure name or "scene". Colors as "#rrggbb".',
  easing: () => `easing: ${EASING_MODES.join(', ')} (auto = smooth, constant = hold).`,
};
