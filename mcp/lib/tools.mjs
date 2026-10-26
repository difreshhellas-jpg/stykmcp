// MCP tool table: short descriptions, zod input shapes, and handlers over a Studio.
// Handlers return a terse string, or {png, text} for previews.
import os from 'node:os';
import path from 'node:path';
import {z} from 'zod';
import {HELP} from './studio.mjs';
import {MOVES} from './moves.mjs';
import {PRESETS} from './figures.mjs';
import {EASING_MODES} from './easing.mjs';
import {SHAPE_KINDS} from './shapes.mjs';

/** Relative paths resolve against STYKMCP_WORKDIR (default ~/StykMCP), never the client's cwd. */
export const workdir = () => path.resolve(process.env.STYKMCP_WORKDIR || path.join(os.homedir(), 'StykMCP'));
const file = value => path.resolve(workdir(), value);

const int = (min, max) => z.number().int().min(min).max(max);
const frame = int(1, 100000);
const frames = z.array(frame).max(500);
const figure = z.union([z.string(), int(1, 1e7)]).describe('figure name or uid');
const color = z.string().regex(/^#?[0-9a-fA-F]{6}$/).describe('#rrggbb');
const easing = z.enum(EASING_MODES);
const degrees = z.record(z.string(), z.number());

export const TOOLS = {
  help: {
    description: 'How-to and reference. topics: basics (includes every tool signature), tools, moves, presets, shapes, camera, effects, easing. Call once before building.',
    shape: {topic: z.enum(['basics', 'tools', 'moves', 'presets', 'shapes', 'camera', 'effects', 'easing']).default('basics')},
    run: (_, {topic}) => topic === 'tools' ? signatures() : topic === 'basics' ? `${HELP.basics}\n\nTools (! required, =default, ? optional):\n${signatures()}` : typeof HELP[topic] === 'function' ? HELP[topic]() : HELP[topic],
  },
  project_new: {
    description: 'Start a new empty animation (replaces the current one).',
    shape: {width: int(16, 7680).default(960), height: int(16, 7680).default(540), fps: int(1, 120).default(24),
      frames: frame.default(48).describe('clip length'), background: color.default('#ffffff'), name: z.string().optional()},
    run: (s, a) => s.newProject(a),
  },
  project_set: {
    description: 'Change size, fps, length (frames), background or name.',
    shape: {width: int(16, 7680).optional(), height: int(16, 7680).optional(), fps: int(1, 120).optional(),
      frames: frame.optional(), background: color.optional(), name: z.string().optional()},
    run: (s, a) => s.setProject(a),
  },
  project_open: {
    description: 'Open .styk, .piv, .stk or .json.',
    shape: {path: z.string()},
    run: (s, a) => s.open(file(a.path)),
  },
  project_save: {
    description: 'Save; format from extension: .styk (editable), .piv/.stk (Pivot), .json.',
    shape: {path: z.string()},
    run: (s, a) => s.save(file(a.path)),
  },
  scene_describe: {
    description: 'Compact summary: size, length, keys, figures (anchor, box), camera, fx. poses=true adds bone angles.',
    shape: {frame: frame.optional(), poses: z.boolean().default(false)},
    run: (s, a) => s.describe(a),
  },
  figure_add: {
    description: `Add a figure from a preset (${Object.keys(PRESETS).join(', ')}) or file. x,y = feet point for stick figures.`,
    shape: {preset: z.enum(Object.keys(PRESETS)).optional(), file: z.string().optional(), name: z.string().max(60).optional(),
      x: z.number().optional(), y: z.number().optional(), scale: z.number().positive().default(1), color: color.optional(),
      size: z.number().positive().optional().describe('ball diameter / ground width'), from: frame.default(1), to: frame.optional()},
    run: (s, a) => s.addFigure({...a, file: a.file && file(a.file)}),
  },
  shape_add: {
    description: `Add a shape as a figure (move/scale/turn it with pose_set): ${SHAPE_KINDS.join(', ')}. x,y = center. See help shapes.`,
    shape: {kind: z.enum(SHAPE_KINDS), x: z.number().optional(), y: z.number().optional(), w: z.number().positive().optional(), h: z.number().positive().optional(),
      size: z.number().positive().optional(), points: z.array(z.tuple([z.number(), z.number()])).max(200).optional().describe('relative to x,y'),
      radius: z.number().min(0).optional(), sides: int(3, 24).optional(), inner: z.number().min(.05).max(1).optional(),
      fill: z.union([color, z.literal('none')]).optional(), color2: color.optional(), stroke: color.optional(), width: z.number().min(0).max(200).optional(),
      opacity: z.number().min(0).max(1).optional(), rotation: z.number().optional(), name: z.string().max(60).optional(), from: frame.default(1), to: frame.optional()},
    run: (s, a) => s.addShape(a),
  },
  text_add: {
    description: 'Add text (vector, Noto Sans) as a figure. x,y = anchor: align edge and vertical middle.',
    shape: {text: z.string().min(1).max(2000), x: z.number().optional(), y: z.number().optional(), size: z.number().min(4).max(1000).default(32), color: color.optional(),
      bold: z.boolean().default(false), italic: z.boolean().default(false), align: z.enum(['left', 'center', 'right']).default('center'),
      opacity: z.number().min(0).max(1).default(1), outline: z.number().min(0).max(64).default(0), outline_color: color.optional(),
      name: z.string().max(60).optional(), from: frame.default(1), to: frame.optional()},
    run: (s, a) => s.addText(a),
  },
  path_draw: {
    description: 'Animate a stroke being drawn on screen from start to end (then stays, or erase later); mode comet = a streak travelling along the path. Path: points (canvas coords, smooth) or shape circle|arc|spiral|wave around x,y.',
    shape: {points: z.array(z.tuple([z.number(), z.number()])).max(200).optional(), smooth: z.boolean().default(true), closed: z.boolean().default(false),
      shape: z.enum(['circle', 'arc', 'spiral', 'wave']).optional(), x: z.number().optional(), y: z.number().optional(), radius: z.number().positive().optional(),
      start_angle: z.number().optional().describe('deg, 0 down 90 right'), sweep: z.number().optional().describe('arc deg, + clockwise'), turns: z.number().positive().optional(), length: z.number().positive().optional(),
      color: color.optional(), width: z.number().positive().max(200).default(6), taper: z.boolean().default(false), opacity: z.number().min(0).max(1).default(1),
      start: frame.default(1), end: frame.optional().describe('drawn by this frame (default start+11)'), mode: z.enum(['draw', 'comet']).default('draw'),
      trail: z.number().min(.01).max(1).default(.3), erase: frame.optional().describe('start erasing at'), erase_end: frame.optional(), to: frame.optional().describe('vanish after'),
      easing: easing.default('ease-out'), name: z.string().max(60).optional()},
    run: (s, a) => s.drawPath(a),
  },
  figure_clone: {
    description: 'Copies of a figure replaying its motion delay frames later, offset dx,dy each: glitch clones, afterimage trails, crowds. Own color/opacity; fade=true fades each copy more.',
    shape: {figure, count: int(1, 12).default(1), delay: int(0, 1000).default(2), dx: z.number().default(0), dy: z.number().default(0),
      color: color.optional(), opacity: z.number().min(0).max(1).optional(), fade: z.boolean().default(false), from: frame.optional(), to: frame.optional(),
      order: z.enum(['back', 'front']).default('back'), name: z.string().max(50).optional()},
    run: (s, a) => s.cloneFigure(a),
  },
  figure_remove: {description: 'Remove a figure everywhere.', shape: {figure}, run: (s, a) => s.removeFigure(a)},
  figure_update: {
    description: 'Rename, recolor, or move a figure to front/back of the draw order.',
    shape: {figure, rename: z.string().max(60).optional(), color: color.optional(), order: z.enum(['front', 'back']).optional()},
    run: (s, a) => s.updateFigure(a),
  },
  pose_set: {
    description: 'Key a figure at frame(s): absolute bone angles (deg, 0=down 90=right), bend (delta, rotates subtree), x/y, dx/dy, scale, turn, flip.',
    shape: {figure, frame: frame.optional(), frames: frames.optional(), angles: degrees.optional(), bend: degrees.optional(),
      x: z.number().optional(), y: z.number().optional(), dx: z.number().optional(), dy: z.number().optional(), scale: z.number().optional(),
      turn: z.number().optional().describe('rotate whole figure, deg'), flip: z.boolean().optional(), ground: z.number().optional().describe('rest lowest point on this y'),
      easing: easing.optional()},
    run: (s, a) => s.pose(a),
  },
  ik_reach: {
    description: 'Key a limb (arm_l, arm_r, leg_l, leg_r) so its hand/foot reaches x,y at a frame.',
    shape: {figure, limb: z.enum(['arm_l', 'arm_r', 'leg_l', 'leg_r']), frame: frame.default(1), x: z.number(), y: z.number(), bend: z.enum(['auto', 'cw', 'ccw']).default('auto')},
    run: (s, a) => s.reach(a),
  },
  move_apply: {
    description: `Generate a preset move on a stick figure from start frame: ${Object.keys(MOVES).join(', ')}. See help moves.`,
    shape: {figure, move: z.enum(Object.keys(MOVES)), start: frame.default(1), speed: z.number().positive().optional(), frames: int(2, 100000).optional(),
      direction: z.enum(['right', 'left']).optional(), intensity: z.number().min(0).max(3).optional(), distance: z.number().optional(), height: z.number().optional(),
      steps: int(1, 200).optional(), cycles: int(1, 200).optional(),
      limb: z.enum(['arm_l', 'arm_r', 'leg_l', 'leg_r']).optional(), easing: easing.optional()},
    run: (s, a) => s.move(a),
  },
  keys: {
    description: 'Keyframe ops: add, delete, copy (frames:[src], to), easing (frames or all), insert_time/remove_time (frames:[at], count).',
    shape: {action: z.enum(['add', 'delete', 'copy', 'easing', 'insert_time', 'remove_time']), frames: frames.default([]), to: frame.optional(),
      easing: easing.optional(), count: int(1, 100000).optional()},
    run: (s, a) => s.keys(a),
  },
  camera_set: {
    description: 'Key the camera at frame(s): center x,y, zoom (2 = closer), rotation deg; reset=true restores the full view.',
    shape: {frame: frame.optional(), frames: frames.optional(), x: z.number().optional(), y: z.number().optional(), zoom: z.number().optional(),
      rotation: z.number().optional(), easing: easing.optional(), reset: z.boolean().optional()},
    run: (s, a) => s.camera(a),
  },
  camera_fx: {
    description: 'Camera move from start to end: punch_in, zoom (keys) or shake, handheld, wobble, impact, pulse, follow (clips). See help camera.',
    shape: {preset: z.enum(['punch_in', 'zoom', 'shake', 'handheld', 'wobble', 'impact', 'pulse', 'follow']), start: frame, end: frame.optional(),
      figure: figure.optional(), x: z.number().optional(), y: z.number().optional(), zoom: z.number().optional(), ramp: int(1, 1000).optional(),
      params: z.record(z.string(), z.number()).optional()},
    run: (s, a) => s.cameraFx(a),
  },
  effect_add: {
    description: 'Add a visual effect clip (glow, blur, shockwave, particles, explosion, smoke, ...) on a figure or "scene". See help effects.',
    shape: {kind: z.string(), target: figure.default('scene'), start: frame.default(1), end: frame.optional(),
      params: z.record(z.string(), z.union([z.number(), z.string()])).optional(), fade_in: int(0, 100000).optional(), fade_out: int(0, 100000).optional()},
    run: (s, a) => s.effect(a),
  },
  fx_remove: {description: 'Remove a camera fx or effect clip by id, or "all".', shape: {id: z.string()}, run: (s, a) => s.removeFx(a)},
  preview: {
    description: 'Small PNG contact sheet (default 8 frames, 160px cells). Use sparingly.',
    shape: {frames: frames.max(48).optional(), count: int(1, 48).default(8), start: frame.optional(), end: frame.optional(),
      width: int(32, 640).default(160), columns: int(1, 12).default(4), path: z.string().optional().describe('also save PNG')},
    run: (s, a) => s.preview({...a, file: a.path && file(a.path)}),
  },
  export: {
    description: 'Render to mp4, webm, gif or png (folder of frames). Format from extension unless given.',
    shape: {path: z.string(), format: z.enum(['mp4', 'webm', 'gif', 'png']).optional(), start: frame.optional(), end: frame.optional(),
      fps: int(1, 120).optional(), width: int(8, 7680).optional(), alpha: z.boolean().default(false)},
    run: (s, a) => s.export({...a, file: file(a.path)}),
  },
  undo: {description: 'Undo the last tool call(s).', shape: {steps: int(1, 60).default(1)}, run: (s, a) => s.undo(a.steps)},
  redo: {description: 'Redo undone tool call(s).', shape: {steps: int(1, 60).default(1)}, run: (s, a) => s.redo(a.steps)},
};

const schemas = Object.fromEntries(Object.entries(TOOLS).map(([name, tool]) => [name, z.object(tool.shape).strict()]));
const BATCHABLE = Object.keys(TOOLS).filter(name => !['help', 'preview', 'undo', 'redo'].includes(name));

TOOLS.batch = {
  description: 'Run many tool calls in order as one undo step: ops=[{tool, args}], args exactly as that tool takes them (see help tools). Stops and rolls back on the first error. Not for preview/undo.',
  shape: {ops: z.array(z.object({tool: z.enum(BATCHABLE), args: z.record(z.string(), z.unknown()).default({})})).min(1).max(200)},
  run: async (s, {ops}) => {
    const lines = [];
    // Validate everything first so a typo late in the list costs no work.
    const parsed = ops.map(({tool, args}, i) => {
      const result = schemas[tool].safeParse(args);
      if (!result.success) throw new Error(`op ${i + 1} (${tool}): ${formatIssues(result.error, args)}. Expected ${signature(tool)}`);
      return [tool, result.data];
    });
    const depth = s.undoStack.length, snapshot = JSON.stringify(s.doc);
    try {
      for (const [i, [tool, args]] of parsed.entries()) {
        try { lines.push(`${i + 1}. ${await TOOLS[tool].run(s, args)}`); }
        catch (error) { throw new Error(`op ${i + 1} (${tool}) failed: ${error.message}. Nothing was applied.`); }
      }
    } catch (error) {
      s.undoStack.length = depth; s._load(JSON.parse(snapshot));
      throw error;
    }
    if (s.undoStack.length > depth + 1) s.undoStack.splice(depth, s.undoStack.length - depth, s.undoStack[depth]);
    return lines.join('\n');
  },
};
schemas.batch = z.object(TOOLS.batch.shape).strict();

export function formatIssues(error, args = {}) {
  return error.issues.map(issue => {
    const key = issue.path.join('.');
    const message = issue.path.length === 1 && args?.[issue.path[0]] === undefined ? 'required' : issue.message;
    return `${key || 'args'}: ${message}`;
  }).join('; ');
}

/** One-line signature from a zod shape: name(req!, opt?, def=1, choice: a|b). */
function describeField(key, field) {
  let type = field, mark = '!', fallback;
  for (;;) {
    const def = type._zod?.def ?? type.def;
    if (def?.type === 'optional') { mark = '?'; type = def.innerType; }
    else if (def?.type === 'default') { mark = '='; fallback = typeof def.defaultValue === 'function' ? def.defaultValue() : def.defaultValue; type = def.innerType; }
    else break;
  }
  const def = type._zod?.def ?? type.def, values = def?.type === 'enum' ? Object.values(def.entries) : null;
  const choices = values && values.length <= 12 ? `:${values.join('|')}` : '';
  return mark === '=' ? `${key}=${JSON.stringify(fallback)}${choices}` : `${key}${mark}${choices}`;
}
export const signature = name => `${name}(${Object.entries(TOOLS[name].shape).map(([key, field]) => describeField(key, field)).join(', ')})`;
const signatures = () => Object.keys(TOOLS).filter(name => name !== 'help').map(signature).join('\n');
export {schemas};
