// Unit tests for the MCP tool layer: document in, document out, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildGeometry, evaluatedFrame, nativeTimeline} from '../../src/pivot/geometry.mjs';
import {cameraMatrix} from '../../src/renderer-geometry.mjs';
import {Studio} from '../lib/studio.mjs';
import {TOOLS, schemas} from '../lib/tools.mjs';
import {toNative, toDegrees, jointPositions, lowestOffset, boneIds, STICK_BONES} from '../lib/figures.mjs';
import {expandMove, MOVES} from '../lib/moves.mjs';

const studio = async () => {
  const s = new Studio({host: null});
  s.newProject({frames: 48});
  await s.addFigure({preset: 'ground', name: 'floor', y: 440});
  await s.addFigure({preset: 'stick', name: 'hero', x: 300, y: 440});
  return s;
};
const hero = (s, tick) => {
  const rows = nativeTimeline(s.doc);
  let index = 0; while (index + 1 < rows.length && rows[index + 1].start <= tick) index++;
  const frame = evaluatedFrame(s.doc, index, rows[index].count > 1 ? (tick - rows[index].start) / s.doc.keyframes[index].duration_raw : 0, tick);
  return {frame, object: frame.objects.find(o => o.unique_id === 2), figure: s.doc.figure_types.find(t => t.name === 'hero')};
};
const close = (a, b, epsilon = 1e-6) => assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`);

test('angle convention: 0 down, 90 right, 180 up', () => {
  close(toNative(0), Math.PI / 2); close(toNative(90), 0); close(toNative(180), -Math.PI / 2);
  for (const deg of [-170, -90, 0, 45, 90, 179]) close(toDegrees(toNative(deg)), deg, 1e-9);
});

test('forward kinematics matches the app geometry evaluator', async () => {
  const s = await studio();
  s.pose({figure: 'hero', frame: 1, angles: {arm_r: 120, forearm_r: 160, thigh_l: 40}, scale: 1.3});
  const {frame, object, figure} = hero(s, 0), geometry = buildGeometry(s.doc, frame);
  const joints = [...geometry.objects.values()].find(o => o.obj.unique_id === 2).joints;
  jointPositions(figure, object).forEach(({end}, i) => {
    const point = joints.get(figure.segments[i].segment_id);
    close(end.x, point.x, 1e-3); close(end.y, point.y, 1e-3);
  });
});

test('new stick figures stand with their feet on the anchor point', async () => {
  const s = await studio(), {object, figure} = hero(s, 0);
  assert.deepEqual(boneIds(figure), STICK_BONES);
  close(object.root_y + lowestOffset(figure, object), 440, 1e-6);
});

test('keying a frame inside a span preserves the motion around it', async () => {
  const s = await studio();
  s.pose({figure: 'hero', frame: 20, dx: 200, angles: {arm_r: 150}});
  const before = [5, 12, 19, 30].map(t => hero(s, t).object);
  s.keys({action: 'add', frames: [12]});
  [5, 12, 19, 30].forEach((t, i) => {
    const after = hero(s, t).object;
    close(after.root_x, before[i].root_x, 1e-6);
    after.angles.forEach((a, j) => close(a, before[i].angles[j], 1e-6));
  });
  assert.equal(s.totalFrames, 48);
});

test('moves place grounded keys on the ground and travel forward', async () => {
  const s = await studio();
  const out = s.move({figure: 'hero', move: 'walk', start: 1, steps: 2, distance: 50});
  assert.match(out, /hero walk f1-24/);
  for (const row of nativeTimeline(s.doc).filter(r => r.start <= 23)) {
    const object = s.doc.keyframes[row.index].objects.find(o => o.unique_id === 2), figure = s.doc.figure_types.find(t => t.name === 'hero');
    close(object.root_y + lowestOffset(figure, object), 440, 1e-6);
  }
  close(hero(s, 23).object.root_x, 400, 1e-6);
});

test('every move expands, mirrors and respects speed', () => {
  for (const name of Object.keys(MOVES)) {
    const {duration, keys} = expandMove(name, {});
    assert.ok(duration >= 2 && keys[0].offset === 0 && keys.at(-1).offset === duration - 1, name);
    for (const key of keys) for (const bone of STICK_BONES) assert.ok(Number.isFinite(key.pose[bone]), `${name} ${bone}`);
  }
  const right = expandMove('kick', {}), left = expandMove('kick', {direction: 'left'});
  close(left.keys[2].pose.thigh_r, -right.keys[2].pose.thigh_r, 1e-9);
  assert.equal(expandMove('walk', {steps: 4, speed: 2}).duration, 24);
  assert.throws(() => expandMove('moonwalk'), /Unknown move/);
});

test('later keys carry a move\'s displacement so moves chain', async () => {
  const s = await studio();
  s.move({figure: 'hero', move: 'kick', start: 30});
  const kickStart = hero(s, 29).object.root_x;
  s.move({figure: 'hero', move: 'walk', start: 1, steps: 2, distance: 50});
  close(hero(s, 29).object.root_x, kickStart + 100, 1e-6);
});

test('ik_reach puts the hand on the target', async () => {
  const s = await studio();
  const out = s.reach({figure: 'hero', limb: 'arm_r', frame: 10, x: 380, y: 260});
  assert.doesNotMatch(out, /out of reach/);
  const {object, figure} = hero(s, 9), end = jointPositions(figure, object)[5].end;
  close(end.x, 380, 1e-6); close(end.y, 260, 1e-6);
});

test('camera_set centers the requested point at the requested zoom', async () => {
  const s = await studio();
  s.camera({frame: 1, x: 300, y: 200, zoom: 2});
  const frame = s.doc.keyframes[0], [a, b, c, d, e, f] = cameraMatrix({report: s.doc, frame});
  close(a * 300 + c * 200 + e, 480, 1e-3); close(b * 300 + d * 200 + f, 270, 1e-3); close(a, 2, 1e-6);
});

test('undo and redo restore whole tool calls', async () => {
  const s = await studio(), original = JSON.stringify(s.doc);
  s.move({figure: 'hero', move: 'jump', start: 5});
  const moved = JSON.stringify(s.doc);
  s.undo(); assert.equal(JSON.stringify(s.doc), original);
  s.redo(); assert.equal(JSON.stringify(s.doc), moved);
});

test('failed operations roll back and explain themselves', async () => {
  const s = await studio(), original = JSON.stringify(s.doc);
  assert.throws(() => s.pose({figure: 'hero', frame: 3, angles: {wing: 10}}), /Unknown bone "wing". Bones: torso head/);
  assert.throws(() => s.pose({figure: 'villain', frame: 3}), /No figure "villain". Figures: floor, hero/);
  assert.throws(() => s.effect({kind: 'glow', target: 'hero', params: {radius: 'big'}}));
  assert.equal(JSON.stringify(s.doc), original);
});

test('batch applies ops as one undo step and rolls back on failure', async () => {
  const s = new Studio({host: null});
  const ok = await TOOLS.batch.run(s, schemas.batch.parse({ops: [
    {tool: 'project_new', args: {frames: 30}},
    {tool: 'figure_add', args: {preset: 'stick', name: 'a', x: 200, y: 400}},
    {tool: 'move_apply', args: {figure: 'a', move: 'wave', start: 2}},
  ]}));
  assert.match(ok, /3\. a wave/);
  const built = JSON.stringify(s.doc), depth = s.undoStack.length;
  await assert.rejects(TOOLS.batch.run(s, schemas.batch.parse({ops: [
    {tool: 'pose_set', args: {figure: 'a', frame: 5, dx: 10}},
    {tool: 'pose_set', args: {figure: 'nobody', frame: 5}},
  ]})), /op 2 \(pose_set\) failed: No figure "nobody".*Nothing was applied/);
  assert.equal(JSON.stringify(s.doc), built); assert.equal(s.undoStack.length, depth);
  assert.throws(() => schemas.batch.parse({ops: [{tool: 'preview', args: {}}]}));
});

test('keys: delete, copy, easing and time edits keep a consistent timeline', async () => {
  const s = await studio();
  s.pose({figure: 'hero', frame: 10, dx: 50}); s.pose({figure: 'hero', frame: 20, dx: 50});
  s.keys({action: 'copy', frames: [1], to: 30});
  close(hero(s, 29).object.root_x, 300, 1e-6);
  s.keys({action: 'easing', frames: [10], easing: 'ease-in'});
  assert.equal(s.doc.keyframes.find((_, i) => nativeTimeline(s.doc)[i].start === 9)._styk.easing.interpolation, 'ease-in');
  s.keys({action: 'insert_time', frames: [10], count: 6});
  assert.equal(s.totalFrames, 54);
  s.keys({action: 'remove_time', frames: [10], count: 6});
  assert.equal(s.totalFrames, 48);
  s.keys({action: 'delete', frames: [20]});
  assert.ok(!nativeTimeline(s.doc).some(r => r.start === 19));
  assert.throws(() => s.keys({action: 'delete', frames: [1]}), /first keyframe/);
});

test('camera fx and effects use the app clip validators', async () => {
  const s = await studio();
  assert.match(s.cameraFx({preset: 'shake', start: 10, end: 20, params: {intensity: 1.5}}), /shake f10-20/);
  assert.match(s.cameraFx({preset: 'punch_in', start: 5, end: 15, figure: 'hero'}), /punch_in f5-15/);
  assert.match(s.effect({kind: 'glow', target: 'hero', start: 1, end: 10, params: {color: '#ff0000', radius: 20}}), /glow on hero/);
  assert.equal(s.doc._styk.vfxClips.clips[0].effects[0].params.color, 0xff0000);
  assert.throws(() => s.cameraFx({preset: 'shake', start: 1, params: {wobbliness: 2}}), /shake params: /);
  const id = s.doc._styk.cameraMotion.clips[0].id;
  assert.match(s.removeFx({id}), /removed/);
  assert.match(s.describe({}), /glow on hero f1-10/);
});

test('describe stays compact', async () => {
  const s = await studio();
  s.move({figure: 'hero', move: 'run', start: 1});
  const text = s.describe({});
  assert.ok(text.length < 600, `${text.length} chars`);
  assert.match(text, /hero \(uid 2, stick, #0d99ff\)/);
});

test('figures and the camera keep independent keys', async () => {
  const s = await studio();
  await s.addFigure({preset: 'ball', name: 'ball', x: 600, y: 400});
  s.pose({figure: 'ball', frame: 20, dy: -100});
  s.pose({figure: 'hero', frame: 41, x: 500, easing: 'linear'});
  s.keys({action: 'easing', frames: [1], easing: 'linear'});
  // The ball's key at frame 20 does not stall the hero's walk from frame 1 to 41.
  close(hero(s, 19).object.root_x, 300 + 200 * 19 / 40, 1e-6);
  s.camera({frame: 1, zoom: 1, easing: 'linear'}); s.camera({frame: 41, zoom: 2});
  const scale = tick => hero(s, tick).frame.camera.scale;
  close(1 / scale(0), 1, 1e-9); close(scale(19), 1 + (0.5 - 1) * 19 / 40, 1e-9); close(1 / scale(40), 2, 1e-9);
});

test('punch_in holds its zoom across keys made by other tools', async () => {
  const s = await studio();
  s.move({figure: 'hero', move: 'jump_kick', start: 5});
  s.cameraFx({preset: 'punch_in', start: 10, end: 30, figure: 'hero', zoom: 1.6, ramp: 3});
  for (const tick of [13, 16, 20, 25, 28]) close(1 / hero(s, tick).frame.camera.scale, 1.6, 1e-6);
  close(1 / hero(s, 29).frame.camera.scale, 1, 1e-6);
});

test('batch validation errors name the field and show the expected signature', async () => {
  const s = new Studio({host: null});
  await assert.rejects(TOOLS.batch.run(s, schemas.batch.parse({ops: [{tool: 'move_apply', args: {move: 'jump'}}]})),
    /op 1 \(move_apply\): figure: required\. Expected move_apply\(figure!, move!:walk\|/);
  await assert.rejects(TOOLS.batch.run(s, schemas.batch.parse({ops: [{tool: 'figure_add', args: {type: 'stick'}}]})),
    /Unrecognized key: "type"\. Expected figure_add\(preset\?:stick\|stick_thin\|ball\|ground/);
  assert.match(TOOLS.help.run(s, {topic: 'basics'}), /camera_fx\(preset!:punch_in\|/);
});

const sample = (s, tick, name) => {
  const rows = nativeTimeline(s.doc), type = s.doc.figure_types.find(t => t.name === name);
  let index = 0; while (index + 1 < rows.length && rows[index + 1].start <= tick) index++;
  const frame = evaluatedFrame(s.doc, index, rows[index].count > 1 ? (tick - rows[index].start) / s.doc.keyframes[index].duration_raw : 0, tick);
  const object = frame.objects.find(o => o.figure_type_id === type.figure_type_id);
  return {frame, object, figure: type, joints: object && [...buildGeometry(s.doc, frame).objects.values()].find(o => o.obj.unique_id === object.unique_id).joints};
};
const drawn = (s, tick, name) => { const {object} = sample(s, tick, name); return object ? object.lengths.reduce((a, b) => a + b, 0) : null; };

test('shape_add builds filled, stroked shapes whose vertices sit around x,y', async () => {
  const s = await studio();
  await s.addShape({kind: 'rect', name: 'box', x: 200, y: 100, w: 80, h: 40, fill: '#ff0000', stroke: '#000000', width: 2});
  const {figure, joints} = sample(s, 0, 'box');
  assert.equal(figure.polyfills.length, 1);
  assert.deepEqual(figure.polyfills[0].color_rgb, [255, 0, 0]);
  const corners = figure.polyfills[0].segment_ids.map(id => joints.get(id)).map(p => [Math.round(p.x), Math.round(p.y)]);
  assert.deepEqual(corners, [[160, 80], [240, 80], [240, 120], [160, 120]]);
  assert.equal(figure.segments.filter(seg => seg.visible).length, 4);
  for (const kind of ['ellipse', 'circle', 'ring', 'star', 'arrow', 'cursor', 'window', 'folder'])
    await s.addShape({kind, w: 60, h: 40, size: 50, name: kind});
  await s.addShape({kind: 'line', points: [[0, 0], [50, 20]], name: 'stroke'});
  assert.equal(sample(s, 0, 'ring').figure.polyfills.length, 0);
  await assert.rejects(s.addShape({kind: 'rect', w: 10}), /rect needs w, h/);
  // A shape is a figure: pose_set moves and turns it rigidly around x,y.
  s.pose({figure: 'box', frame: 10, x: 400, y: 300, turn: 90});
  const turned = sample(s, 9, 'box');
  const moved = turned.figure.polyfills[0].segment_ids.map(id => turned.joints.get(id)).map(p => [Math.round(p.x), Math.round(p.y)]);
  assert.deepEqual(moved, [[380, 340], [380, 260], [420, 260], [420, 340]]);
});

test('text_add anchors text at x,y', async () => {
  const s = await studio();
  await s.addText({text: 'Scan complete\n0 threats', name: 'msg', x: 480, y: 270, size: 30, bold: true});
  const box = line => line.match(/box (-?\d+),(-?\d+),(-?\d+),(-?\d+)/).slice(1).map(Number);
  const [x0, y0, x1, y1] = box(s.describe().split('\n').find(l => l.startsWith('- msg')));
  assert.ok(Math.abs((x0 + x1) / 2 - 480) <= 1 && Math.abs((y0 + y1) / 2 - 270) <= 1, `${x0},${y0},${x1},${y1}`);
  assert.ok(y1 - y0 > 50, `two lines tall: ${y1 - y0}`);
  await s.addText({text: 'left', name: 'l', x: 100, y: 50, align: 'left'});
  assert.equal(box(s.describe().split('\n').find(l => l.startsWith('- l ')))[0], 100);
  assert.match(s.describe(), /msg \(uid \d+, text,/);
});

test('path_draw draws on, holds, erases; comet travels and vanishes', async () => {
  const s = await studio();
  const out = await s.drawPath({name: 'ring', shape: 'circle', x: 300, y: 200, radius: 50, start: 5, end: 15, erase: 30, erase_end: 35, easing: 'linear'});
  assert.match(out, /f5-15, gone after f35/);
  const full = 2 * Math.PI * 50;
  assert.equal(drawn(s, 3, 'ring'), null);
  close(drawn(s, 4, 'ring'), 0, 1e-6);
  close(drawn(s, 9, 'ring'), full / 2, full * .02);
  close(drawn(s, 14, 'ring'), full, full * .02);
  close(drawn(s, 25, 'ring'), full, full * .02);
  close(drawn(s, 32, 'ring'), full * .4, full * .03);
  assert.equal(drawn(s, 36, 'ring'), null);
  // The visible part starts where erasing has reached: the origin moves along the path.
  const {object} = sample(s, 32, 'ring');
  assert.ok(Math.hypot(object.root_x - 300, object.root_y - 200) > 45, 'origin stays on the circle');
  await s.drawPath({name: 'streak', points: [[100, 300], [300, 280], [500, 320]], mode: 'comet', trail: .25, start: 10, end: 20, easing: 'linear'});
  const lengths = [10, 15, 19].map(f => drawn(s, f - 1, 'streak'));
  assert.ok(lengths[1] > lengths[0] && lengths[1] > lengths[2], lengths.join());
  assert.equal(drawn(s, 21, 'streak'), null);
  assert.ok(s.doc.figure_types.find(t => t.name === 'streak').segments.length >= 2);
});

test('figure_clone replays the figure late and offset, behind it', async () => {
  const s = await studio();
  s.move({figure: 'hero', move: 'walk', start: 1, steps: 4});
  const out = s.cloneFigure({figure: 'hero', count: 2, delay: 4, dx: -30, color: '#ff0000', fade: true});
  assert.match(out, /hero_copy1, hero_copy2/);
  for (const tick of [8, 12, 20, 28]) {
    const original = sample(s, tick - 8, 'hero').object, copy = sample(s, tick, 'hero_copy2').object;
    close(copy.root_x, original.root_x - 60, 1.5);
    copy.angles.forEach((angle, i) => close(Math.cos(angle - original.angles[i]), 1, 2e-3));
  }
  const type = s.doc.figure_types.find(t => t.name === 'hero_copy1');
  assert.deepEqual(type.segments[0].color_rgb, [255, 0, 0]);
  assert.ok(type.segments[0].transparency > 0);
  const order = s.doc.keyframes[0].object_draw_order_unique_ids, uid = name => s._figure(s.doc, name).uid;
  assert.ok(order.indexOf(uid('hero_copy1')) < order.indexOf(uid('hero')) && order.indexOf(uid('hero_copy2')) < order.indexOf(uid('hero')));
  s.undo(); assert.ok(!s.doc.figure_types.some(t => t.name === 'hero_copy1'));
});

test('new tools work in a batch and roll back together', async () => {
  const s = await studio();
  await assert.rejects(TOOLS.batch.run(s, {ops: [
    {tool: 'shape_add', args: {kind: 'window', w: 300, h: 200, name: 'win'}},
    {tool: 'text_add', args: {text: 'hi', name: 'label'}},
    {tool: 'path_draw', args: {shape: 'arc', x: 1, y: 1, start: 10, end: 5}},
  ]}), /op 3 \(path_draw\) failed: end must be after start/);
  assert.ok(!s.doc.figure_types.some(t => t.name === 'win' || t.name === 'label'));
  assert.ok(schemas.shape_add.safeParse({kind: 'star', size: 40}).success);
});
