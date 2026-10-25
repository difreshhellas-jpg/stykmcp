// Preset moves for the stick topology. Each move is a list of key poses in MCP
// degrees (facing right; see figures.mjs), placed at fractions of its duration.
// `dx` is forward travel in pixels, `lift` the height of the lowest joint above
// the ground. Bones a key omits keep the standing pose.
import {STAND, wrap} from './figures.mjs';

const GUARD = {arm_l: 45, forearm_l: 150, arm_r: 25, forearm_r: 160};

// Walk and run cycles: two steps, the left leg leading first.
const walkStep = side => {
  const [f, b] = side === 'l' ? ['l', 'r'] : ['r', 'l'];
  return [
    {t: 0, pose: {torso: 176, [`thigh_${f}`]: 25, [`shin_${f}`]: 12, [`thigh_${b}`]: -18, [`shin_${b}`]: -38, [`arm_${b}`]: 24, [`forearm_${b}`]: 48, [`arm_${f}`]: -22, [`forearm_${f}`]: -12}},
    {t: .5, pose: {torso: 178, [`thigh_${f}`]: 2, [`shin_${f}`]: 0, [`thigh_${b}`]: 14, [`shin_${b}`]: -28, [`arm_${b}`]: 2, [`forearm_${b}`]: 16, [`arm_${f}`]: -2, [`forearm_${f}`]: 6}},
  ];
};
const runStep = side => {
  const [f, b] = side === 'l' ? ['l', 'r'] : ['r', 'l'];
  return [
    {t: 0, pose: {torso: 164, head: 170, [`thigh_${f}`]: 32, [`shin_${f}`]: 8, [`thigh_${b}`]: -30, [`shin_${b}`]: -78, [`arm_${b}`]: 45, [`forearm_${b}`]: 125, [`arm_${f}`]: -45, [`forearm_${f}`]: 40}},
    {t: .5, lift: 10, pose: {torso: 166, head: 172, [`thigh_${f}`]: -10, [`shin_${f}`]: -70, [`thigh_${b}`]: 55, [`shin_${b}`]: -10, [`arm_${b}`]: -10, [`forearm_${b}`]: 80, [`arm_${f}`]: 10, [`forearm_${f}`]: 95}},
  ];
};

function cycle(stepFor, steps, extra = {}) {
  const keys = [];
  for (let i = 0; i < steps; i++) for (const key of stepFor(i % 2 ? 'r' : 'l')) keys.push({...key, t: (i + key.t) / steps});
  keys.push({t: 1, pose: {}, ...extra});
  return keys;
}

export const MOVES = {
  walk: {about: 'walk cycle; steps, distance', frames: 12, per: 'step', defaults: {steps: 4, distance: 60},
    build: p => cycle(walkStep, p.steps).map(k => ({...k, dx: p.distance * p.steps * k.t}))},
  run: {about: 'run cycle; steps, distance', frames: 8, per: 'step', defaults: {steps: 6, distance: 110},
    build: p => cycle(runStep, p.steps).map(k => ({...k, dx: p.distance * p.steps * k.t}))},
  jump: {about: 'crouch, jump, land; height, distance', frames: 24, defaults: {height: 110, distance: 0},
    build: p => [
      {t: 0, pose: {}},
      {t: .2, pose: {torso: 158, head: 165, thigh_l: 62, shin_l: -25, thigh_r: 52, shin_r: -30, arm_l: -50, forearm_l: -30, arm_r: -60, forearm_r: -40}},
      {t: .36, lift: 14, dx: .15, pose: {torso: 175, thigh_l: 2, shin_l: -4, thigh_r: -6, shin_r: -10, arm_l: 165, forearm_l: 170, arm_r: 150, forearm_r: 160}},
      {t: .55, lift: p.height, dx: .5, pose: {torso: 172, thigh_l: 75, shin_l: -5, thigh_r: 60, shin_r: -15, arm_l: 110, forearm_l: 130, arm_r: 95, forearm_r: 120}},
      {t: .75, lift: p.height * .45, dx: .85, pose: {torso: 176, thigh_l: 20, shin_l: 5, thigh_r: 10, shin_r: 0, arm_l: 80, forearm_l: 70, arm_r: 70, forearm_r: 60}},
      {t: .86, dx: 1, pose: {torso: 160, head: 168, thigh_l: 60, shin_l: -22, thigh_r: 48, shin_r: -28, arm_l: 40, forearm_l: 50, arm_r: 30, forearm_r: 40}},
      {t: 1, dx: 1, pose: {}},
    ].map(k => ({...k, dx: (k.dx ?? 0) * p.distance}))},
  punch: {about: 'guard, straight punch, recover; limb (arm_l|arm_r)', frames: 14, defaults: {limb: 'arm_r'},
    build: p => {
      const [a, o] = p.limb === 'arm_l' ? ['l', 'r'] : ['r', 'l'];
      return [
        {t: 0, pose: {}},
        {t: .3, pose: {...GUARD, torso: 184, thigh_l: 18, thigh_r: -14}},
        {t: .5, dx: 8, pose: {...GUARD, torso: 168, head: 172, [`arm_${a}`]: 94, [`forearm_${a}`]: 92, [`arm_${o}`]: 30, [`forearm_${o}`]: 155, thigh_l: 22, shin_l: 8, thigh_r: -18, shin_r: -6}},
        {t: .68, dx: 8, pose: {...GUARD, torso: 170, head: 174, [`arm_${a}`]: 92, [`forearm_${a}`]: 90, [`arm_${o}`]: 30, [`forearm_${o}`]: 155, thigh_l: 22, shin_l: 8, thigh_r: -18, shin_r: -6}},
        {t: .85, dx: 4, pose: {...GUARD, torso: 180, thigh_l: 16, thigh_r: -12}},
        {t: 1, pose: {}},
      ];
    }},
  kick: {about: 'chamber, front kick, recover; limb (leg_l|leg_r), height', frames: 18, defaults: {limb: 'leg_r', height: 1},
    build: p => {
      const [k, s] = p.limb === 'leg_l' ? ['l', 'r'] : ['r', 'l'], h = p.height;
      return [
        {t: 0, pose: {}},
        {t: .28, pose: {...GUARD, torso: 192, [`thigh_${k}`]: 95 * h, [`shin_${k}`]: -5, [`thigh_${s}`]: -4, [`shin_${s}`]: 0}},
        {t: .45, dx: 6, pose: {...GUARD, torso: 205, head: 195, arm_l: -40, forearm_l: -10, arm_r: 70, forearm_r: 140, [`thigh_${k}`]: 82 + 8 * h, [`shin_${k}`]: 82 + 12 * h, [`thigh_${s}`]: -6, [`shin_${s}`]: 0}},
        {t: .6, dx: 6, pose: {...GUARD, torso: 203, head: 194, arm_l: -38, forearm_l: -10, arm_r: 70, forearm_r: 140, [`thigh_${k}`]: 82 + 8 * h, [`shin_${k}`]: 80 + 12 * h, [`thigh_${s}`]: -6, [`shin_${s}`]: 0}},
        {t: .78, dx: 4, pose: {...GUARD, torso: 190, [`thigh_${k}`]: 85 * h, [`shin_${k}`]: -10, [`thigh_${s}`]: -4}},
        {t: 1, dx: 10, pose: {}},
      ];
    }},
  jump_kick: {about: 'crouch, leap, flying kick, land; limb (leg_l|leg_r), height, distance', frames: 30, defaults: {limb: 'leg_r', height: 90, distance: 120},
    build: p => {
      const [k, s] = p.limb === 'leg_l' ? ['l', 'r'] : ['r', 'l'];
      return [
        {t: 0, pose: {}},
        {t: .18, pose: {...GUARD, torso: 158, head: 166, thigh_l: 62, shin_l: -25, thigh_r: 52, shin_r: -30}},
        {t: .32, lift: 30, dx: .2, pose: {torso: 178, [`thigh_${k}`]: 70, [`shin_${k}`]: -10, [`thigh_${s}`]: -10, [`shin_${s}`]: -20, arm_l: 150, forearm_l: 160, arm_r: 130, forearm_r: 150}},
        {t: .48, lift: p.height, dx: .55, pose: {torso: 200, head: 192, [`thigh_${k}`]: 84, [`shin_${k}`]: 88, [`thigh_${s}`]: 40, [`shin_${s}`]: -60, arm_l: -70, forearm_l: -40, arm_r: 120, forearm_r: 140}},
        {t: .62, lift: p.height * .8, dx: .8, pose: {torso: 198, head: 190, [`thigh_${k}`]: 82, [`shin_${k}`]: 86, [`thigh_${s}`]: 38, [`shin_${s}`]: -58, arm_l: -70, forearm_l: -40, arm_r: 120, forearm_r: 140}},
        {t: .78, lift: 12, dx: .95, pose: {torso: 178, thigh_l: 30, shin_l: 5, thigh_r: 20, shin_r: 0, arm_l: 70, forearm_l: 90, arm_r: 50, forearm_r: 80}},
        {t: .88, dx: 1, pose: {torso: 160, head: 168, thigh_l: 60, shin_l: -22, thigh_r: 48, shin_r: -28, arm_l: 40, forearm_l: 60, arm_r: 30, forearm_r: 50}},
        {t: 1, dx: 1, pose: {}},
      ].map(key => ({...key, dx: (key.dx ?? 0) * p.distance}));
    }},
  fall: {about: 'hit, fall backwards, lie on the ground; distance', frames: 24, defaults: {distance: 40},
    build: p => [
      {t: 0, pose: {}},
      {t: .15, dx: -.2, pose: {torso: 205, head: 215, arm_l: 120, forearm_l: 140, arm_r: 100, forearm_r: 120, thigh_l: 15, thigh_r: 0}},
      {t: .4, dx: -.6, lift: 6, pose: {torso: 235, head: 240, arm_l: 160, forearm_l: 170, arm_r: 140, forearm_r: 150, thigh_l: 35, shin_l: 20, thigh_r: 25, shin_r: 10}},
      {t: .65, dx: -1, pose: {torso: 268, head: 272, arm_l: 200, forearm_l: 215, arm_r: 235, forearm_r: 250, thigh_l: 80, shin_l: 70, thigh_r: 70, shin_r: 85}},
      {t: .75, dx: -1, lift: 6, pose: {torso: 262, head: 262, arm_l: 205, forearm_l: 225, arm_r: 230, forearm_r: 245, thigh_l: 70, shin_l: 95, thigh_r: 62, shin_r: 100}},
      {t: 1, dx: -1, pose: {torso: 270, head: 274, arm_l: 215, forearm_l: 230, arm_r: 240, forearm_r: 255, thigh_l: 82, shin_l: 86, thigh_r: 76, shin_r: 92}},
    ].map(key => ({...key, dx: (key.dx ?? 0) * p.distance}))},
  wave: {about: 'raise an arm and wave; limb (arm_l|arm_r), cycles', frames: 8, per: 'cycle', defaults: {limb: 'arm_r', cycles: 3},
    build: p => {
      const a = p.limb === 'arm_l' ? 'l' : 'r', keys = [{t: 0, pose: {}}], n = p.cycles, span = .8 / n;
      for (let i = 0; i < n; i++) {
        keys.push({t: .1 + i * span, pose: {[`arm_${a}`]: 140, [`forearm_${a}`]: 160}});
        keys.push({t: .1 + (i + .5) * span, pose: {[`arm_${a}`]: 135, [`forearm_${a}`]: 205}});
      }
      keys.push({t: .1 + n * span, pose: {[`arm_${a}`]: 140, [`forearm_${a}`]: 165}});
      keys.push({t: 1, pose: {}});
      return keys;
    }},
  idle: {about: 'breathing idle loop; cycles', frames: 24, per: 'cycle', defaults: {cycles: 2},
    build: p => cycle(() => [{t: 0, pose: {}}, {t: .5, pose: {torso: 177, head: 176, arm_l: 18, arm_r: -10, forearm_l: 12, forearm_r: -2}}], p.cycles)},
  crouch: {about: 'crouch down and hold (end with jump or another move)', frames: 8, defaults: {},
    build: () => [{t: 0, pose: {}}, {t: 1, pose: {torso: 160, head: 168, thigh_l: 70, shin_l: -30, thigh_r: 60, shin_r: -35, arm_l: 50, forearm_l: 80, arm_r: 30, forearm_r: 60}}]},
};

/** Expand a move into absolute key poses: [{offset, pose, dx, lift}] with frame offsets from start. */
export function expandMove(name, params = {}) {
  const move = MOVES[name];
  if (!move) throw new Error(`Unknown move "${name}". Moves: ${Object.keys(MOVES).join(', ')}`);
  const p = {...move.defaults, ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))};
  const speed = p.speed ?? 1, intensity = p.intensity ?? 1;
  if (!(speed > 0 && speed <= 10)) throw new Error('speed must be in (0, 10].');
  const units = move.per === 'step' ? p.steps : move.per === 'cycle' ? p.cycles : 1;
  const duration = Math.max(2, Math.round(p.frames ?? move.frames * units / speed));
  const mirror = p.direction === 'left' ? -1 : 1;
  const seen = new Map();
  for (const key of move.build(p)) {
    const offset = Math.round(key.t * duration);
    const pose = {};
    for (const [bone, stand] of Object.entries(STAND)) {
      const target = key.pose[bone] ?? stand, delta = wrap(target - stand) * intensity;
      pose[bone] = wrap((stand + delta) * mirror);
    }
    // Later keys at the same rounded frame win (short durations).
    seen.set(offset, {offset, pose, dx: (key.dx ?? 0) * mirror, lift: (key.lift ?? 0) * intensity});
  }
  return {duration, keys: [...seen.values()].sort((a, b) => a.offset - b.offset)};
}
