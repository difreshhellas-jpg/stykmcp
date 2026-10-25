#!/usr/bin/env node
// StykMCP: an MCP server (stdio) for authoring stick-figure animations with the
// StykAnimate engine. Independent fork of StykAnimate (GPL-3.0-or-later); not
// endorsed by the original author.
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {Studio} from './lib/studio.mjs';
import {RenderHost} from './lib/render-host.mjs';
import {TOOLS, workdir} from './lib/tools.mjs';

// Headless mode never loads the app shell, so its consent-gated telemetry,
// diagnostics and update checks never start; the render page can reach only
// its own loopback origin (see render-host.mjs).
const log = message => process.stderr.write(`[stykmcp] ${message}\n`);
const sizeLog = process.env.STYKMCP_LOG_SIZES === '1';

const host = new RenderHost({log});
const studio = new Studio({host});
const server = new McpServer({name: 'stykmcp', version: '0.1.0'},
  {instructions: 'Stick-figure animation. Call help once, then build with batch (project_new, figure_add, move_apply, camera_fx, effect_add), preview sparingly, export. Paths are relative to ' + workdir() + '.'});

// Tool calls run strictly one at a time against the single document.
let queue = Promise.resolve();
const serial = task => { const run = queue.then(task, task); queue = run.catch(() => {}); return run; };

for (const [name, tool] of Object.entries(TOOLS)) {
  server.registerTool(name, {description: tool.description, inputSchema: tool.shape}, args => serial(async () => {
    try {
      const result = await tool.run(studio, args);
      const content = result?.png
        ? [{type: 'image', data: result.png.toString('base64'), mimeType: 'image/png'}, {type: 'text', text: result.text}]
        : [{type: 'text', text: String(result)}];
      if (sizeLog) log(`${name} -> ${content.reduce((n, c) => n + (c.text?.length ?? c.data.length), 0)} chars`);
      return {content};
    } catch (error) {
      return {isError: true, content: [{type: 'text', text: `${name}: ${error.message}`}]};
    }
  }));
}

const shutdown = async () => { await host.close().catch(() => {}); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);
await server.connect(new StdioServerTransport());
log(`ready; files resolve against ${workdir()}`);
