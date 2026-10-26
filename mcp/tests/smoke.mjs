// Headless smoke test through the real MCP server over stdio, using only tool calls:
// a 2-second jump clip exported to MP4 and verified with ffprobe, then a .piv
// round trip (open, edit, export GIF, save .piv/.styk, reopen). Reports the size
// of every tool response (the agent's token cost) and of the tool list itself.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtempSync, existsSync, writeFileSync, mkdirSync, copyFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {probe} from '../lib/encode.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workdir = process.env.STYKMCP_WORKDIR || mkdtempSync(path.join(os.tmpdir(), 'stykmcp-smoke-'));
const transport = new StdioClientTransport({command: process.execPath, args: [path.join(root, 'mcp', 'server.mjs')], cwd: root,
  env: {...process.env, STYKMCP_WORKDIR: workdir}, stderr: 'inherit'});
const client = new Client({name: 'stykmcp-smoke', version: '1'});
await client.connect(transport);

const report = [];
async function call(name, args) {
  const started = performance.now(), result = await client.callTool({name, arguments: args});
  const chars = result.content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : c.data.length), 0);
  const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  report.push({tool: name, chars, images: result.content.filter(c => c.type === 'image').length, ms: Math.round(performance.now() - started)});
  if (result.isError) throw new Error(text);
  return {text, result};
}

const {tools} = await client.listTools();
const toolListChars = JSON.stringify(tools).length;

// 1. Build the whole 2-second clip in one batch.
const build = await call('batch', {ops: [
  {tool: 'project_new', args: {width: 640, height: 360, fps: 24, frames: 48, background: '#f4f1ea'}},
  {tool: 'figure_add', args: {preset: 'ground', name: 'floor', y: 300}},
  {tool: 'figure_add', args: {preset: 'stick', name: 'hero', x: 220, y: 300, scale: .8}},
  {tool: 'move_apply', args: {figure: 'hero', move: 'jump', start: 6, frames: 30, height: 90, distance: 120}},
  {tool: 'camera_fx', args: {preset: 'impact', start: 32}},
]});
console.log(build.text);
// 2. Check, preview, export.
const described = await call('scene_describe', {});
console.log(described.text);
assert.match(described.text, /640x360 24fps 48f \(2s\)/);
const preview = await call('preview', {count: 8, width: 120});
const image = preview.result.content.find(c => c.type === 'image');
assert.ok(image && image.data.length > 1000, 'preview returned an image');
mkdirSync(path.join(root, 'artifacts'), {recursive: true});
writeFileSync(path.join(root, 'artifacts', 'mcp-smoke-preview.png'), Buffer.from(image.data, 'base64'));
const exported = await call('export', {path: 'smoke/jump.mp4'});
console.log(exported.text);

const file = path.join(workdir, 'smoke', 'jump.mp4');
assert.ok(existsSync(file), 'mp4 exists');
const info = await probe(file);
console.log('ffprobe', JSON.stringify(info));
assert.equal(info.width, 640); assert.equal(info.height, 360);
assert.equal(Math.round(info.fps), 24); assert.equal(info.frames, 48);
assert.ok(Math.abs(info.duration - 2) < .05, `duration ${info.duration}`);

// 3. Undo works across the batch as one step.
const undone = await call('undo', {});
assert.match(undone.text, /undid 1/);

// 4. Round trip: open a Pivot .piv fixture, modify it, export, save and reopen.
copyFileSync(path.join(root, 'mcp', 'tests', 'fixtures', 'hop.piv'), path.join(workdir, 'hop.piv'));
const opened = await call('project_open', {path: 'hop.piv'});
assert.match(opened.text, /480x270 12fps 12f/);
const edited = await call('batch', {ops: [
  {tool: 'project_set', args: {frames: 24, background: '#202830'}},
  {tool: 'move_apply', args: {figure: 'pivoter', move: 'wave', start: 13, frames: 12}},
  {tool: 'figure_update', args: {figure: 'pivoter', color: '#ffd23c'}},
  {tool: 'project_save', args: {path: 'roundtrip/hop-edit.piv'}},
  {tool: 'project_save', args: {path: 'roundtrip/hop-edit.styk'}},
]});
console.log(edited.text);
const gif = await call('export', {path: 'roundtrip/hop-edit.gif'});
const gifInfo = await probe(path.join(workdir, 'roundtrip', 'hop-edit.gif'));
console.log(gif.text, JSON.stringify(gifInfo));
assert.equal(gifInfo.frames, 24); assert.equal(gifInfo.width, 480);
for (const ext of ['piv', 'styk']) {
  const back = await call('project_open', {path: `roundtrip/hop-edit.${ext}`});
  assert.match(back.text, /480x270 12fps 24f/, ext);
  assert.match((await call('scene_describe', {})).text, /pivoter \(uid 1, stick, #ffd23c\)/, ext);
}
// 5. The target workflow: "a 3-second jump kick with a camera punch-in, export MP4".
const typical = report.length;
await call('help', {topic: 'basics'});
await call('help', {topic: 'moves'});
const clip = await call('batch', {ops: [
  {tool: 'project_new', args: {frames: 72}},
  {tool: 'figure_add', args: {preset: 'ground', name: 'floor', y: 440}},
  {tool: 'figure_add', args: {preset: 'stick', name: 'hero', x: 260, y: 440}},
  {tool: 'move_apply', args: {figure: 'hero', move: 'jump_kick', start: 12}},
  {tool: 'camera_fx', args: {preset: 'punch_in', start: 24, end: 44, figure: 'hero', zoom: 1.6}},
  {tool: 'camera_fx', args: {preset: 'impact', start: 26}},
  {tool: 'export', args: {path: 'clips/jump-kick.mp4'}},
]});
console.log(clip.text);
await call('preview', {count: 8});
const kick = await probe(path.join(workdir, 'clips', 'jump-kick.mp4'));
assert.equal(kick.frames, 72); assert.ok(Math.abs(kick.duration - 3) < .05);
const scenario = report.slice(typical);
// 6. Shapes, text, drawn strokes and clones: a 2-second desktop scene, saved as .styk and .piv.
const scene = await call('batch', {ops: [
  {tool: 'project_new', args: {frames: 48, background: '#2b5797'}},
  {tool: 'shape_add', args: {kind: 'rect', name: 'taskbar', x: 480, y: 525, w: 960, h: 30, fill: '#1b1f2a'}},
  {tool: 'shape_add', args: {kind: 'folder', name: 'docs', x: 60, y: 60, w: 56, h: 44, fill: '#f2c94c'}},
  {tool: 'shape_add', args: {kind: 'window', name: 'win', x: 640, y: 200, w: 420, h: 260, fill: '#ffffff'}},
  {tool: 'shape_add', args: {kind: 'cursor', name: 'cursor', x: 300, y: 300, size: 28, fill: '#ffffff', stroke: '#000000', width: 2}},
  {tool: 'text_add', args: {text: 'Scan complete: 0 threats', name: 'msg', x: 640, y: 200, size: 24, bold: true, from: 30}},
  {tool: 'figure_add', args: {preset: 'stick', name: 'hero', x: 300, y: 470, color: '#ff6b2c'}},
  {tool: 'move_apply', args: {figure: 'hero', move: 'walk', start: 1, steps: 4}},
  {tool: 'figure_clone', args: {figure: 'hero', count: 2, delay: 3, dx: -24, color: '#ff2020', fade: true}},
  {tool: 'path_draw', args: {shape: 'circle', x: 640, y: 230, radius: 70, width: 8, taper: true, start: 4, end: 18}},
  {tool: 'path_draw', args: {points: [[400, 330], [560, 300], [780, 320]], mode: 'comet', start: 10, end: 28}},
  {tool: 'pose_set', args: {figure: 'cursor', frame: 40, x: 640, y: 220}},
  {tool: 'export', args: {path: 'clips/desktop.mp4'}},
  {tool: 'project_save', args: {path: 'clips/desktop.styk'}},
  {tool: 'project_save', args: {path: 'clips/desktop.piv'}},
]});
console.log(scene.text);
const desktop = await probe(path.join(workdir, 'clips', 'desktop.mp4'));
assert.equal(desktop.frames, 48);
for (const ext of ['styk', 'piv']) {
  await call('project_open', {path: `clips/desktop.${ext}`});
  assert.match((await call('scene_describe', {frame: 30})).text, /msg \(uid \d+, (text|2 bones)/, ext);
}
await client.close();

const scenarioText = scenario.reduce((n, r) => n + (r.images ? 0 : r.chars), 0);
console.log(`3-second jump kick: ${scenario.length} tool calls, ${scenarioText} chars of text output (+1 preview image); mp4 ${JSON.stringify(kick)}`);
const total = report.reduce((n, r) => n + r.chars, 0), textOnly = report.reduce((n, r) => n + (r.images ? 0 : r.chars), 0);
console.table(report);
console.log(`tool calls: ${report.length}; response chars: ${total} (text ${textOnly}, preview image base64 ${total - textOnly}); tool list: ${tools.length} tools, ${toolListChars} chars`);
console.log(`ok: ${file}`);
