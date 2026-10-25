// Headless smoke test through the real MCP server over stdio, using only tool calls:
// a 2-second jump clip exported to MP4, verified with ffprobe. Reports the size of
// every tool response (the agent's token cost) and of the tool list itself.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtempSync, existsSync, writeFileSync, mkdirSync} from 'node:fs';
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
await client.close();

const total = report.reduce((n, r) => n + r.chars, 0), textOnly = report.reduce((n, r) => n + (r.images ? 0 : r.chars), 0);
console.table(report);
console.log(`tool calls: ${report.length}; response chars: ${total} (text ${textOnly}, preview image base64 ${total - textOnly}); tool list: ${tools.length} tools, ${toolListChars} chars`);
console.log(`ok: ${file}`);
