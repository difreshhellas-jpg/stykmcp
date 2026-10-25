// Node side of the render bridge. Lazily starts, in order:
//   1. the app's local codec service (backend/server.py via desktop/backend.cjs),
//      which serves the app's files and reads/writes .piv/.stk/.styk;
//      if Python is unavailable, a tiny Node static host serves the files and only
//      file conversion is unavailable;
//   2. one headless browser page (mcp/render/page.html) that rasterizes with the
//      app's own export renderer (Canvas 2D; no GPU needed).
// The page can reach nothing but that loopback origin.
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {startStaticServer} from './static-server.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

async function launchBrowser() {
  const {chromium} = await import('playwright');
  // Software rendering keeps output identical across machines and avoids GPU driver issues.
  const args = ['--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-default-apps'];
  const attempts = [];
  const choices = process.env.STYKMCP_BROWSER ? [process.env.STYKMCP_BROWSER] : ['chromium', 'msedge', 'chrome'];
  for (const choice of choices) {
    try {
      const options = {headless: true, args};
      if (choice === 'msedge' || choice === 'chrome') options.channel = choice;
      else if (choice !== 'chromium') options.executablePath = choice;
      return await chromium.launch(options);
    } catch (error) { attempts.push(`${choice}: ${String(error.message).split('\n')[0]}`); }
  }
  throw new Error(`No headless browser could start. Run "npx playwright install chromium" (or install Edge/Chrome). ${attempts.join(' | ')}`);
}

export class RenderHost {
  constructor({log = () => {}} = {}) { this.log = log; this.revision = null; this.codecError = null; }
  /** The loopback origin: the codec service when possible, else the static host. */
  async _origin() {
    if (this.origin) return this.origin;
    if (process.env.STYKMCP_NO_CODEC !== '1') {
      try {
        const {startBackend} = require('../../desktop/backend.cjs');
        this.token = randomBytes(24).toString('hex');
        this.backend = await startBackend({appRoot, resourcesPath: appRoot, token: this.token, log: () => {}, onError: message => this.log(String(message))});
        return this.origin = this.backend.origin;
      } catch (error) {
        this.codecError = `The local codec service (Python 3.10+) could not start: ${String(error.message || error).split('\n')[0]}`;
        this.log(this.codecError);
      }
    }
    this.server = await startStaticServer(appRoot);
    return this.origin = this.server.origin;
  }
  async _page() {
    if (this.page) return this.page;
    const origin = await this._origin();
    this.browser = await launchBrowser();
    const context = await this.browser.newContext({serviceWorkers: 'block'});
    // No network access beyond the local origin: no telemetry, fonts, updates or other hosts.
    await context.route('**/*', route => {
      const url = route.request().url();
      return url.startsWith(origin + '/') || url.startsWith('data:') || url.startsWith('blob:') ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    this.errors = [];
    page.on('pageerror', error => this.errors.push(error.message));
    await page.goto(`${origin}/mcp/render/page.html`);
    await page.waitForFunction(() => window.__stykMcp?.ready === true, null, {timeout: 30000});
    return this.page = page;
  }
  async _sync(report, revision) {
    const page = await this._page();
    if (this.revision !== revision || revision === undefined) {
      await page.evaluate(json => window.__stykMcp.setDocument(json), JSON.stringify(report));
      this.revision = revision;
    }
    return page;
  }
  /** Render ticks to PNG Buffers at width x height. */
  async frames(report, revision, {ticks, width, height, smoothing = 'edges', alpha = false}) {
    const page = await this._sync(report, revision);
    const encoded = await page.evaluate(options => window.__stykMcp.frames(options), {ticks, width, height, smoothing, alpha});
    return encoded.map(text => Buffer.from(text, 'base64'));
  }
  async sheet(report, revision, options) {
    const page = await this._sync(report, revision);
    return Buffer.from(await page.evaluate(value => window.__stykMcp.sheet(value), options), 'base64');
  }
  async _codec() {
    await this._origin();
    if (!this.backend) throw new Error(this.codecError || 'The local codec service is unavailable (Python 3.10+ is required for .piv/.stk/.styk files).');
  }
  /** Encode the document as styk, piv or stk; returns a Buffer. */
  async save(report, revision, {format, name, figureTypeId}) {
    await this._codec();
    const page = await this._sync(report, revision);
    return Buffer.from(await page.evaluate(options => window.__stykMcp.save(options),
      {format, name, figureTypeId, codecOrigin: this.origin, token: this.token}), 'base64');
  }
  /** Decode a .piv/.stk/.styk/.json file into a document. */
  async open(bytes, filename) {
    await this._codec();
    const response = await fetch(`${this.origin}/api/import?filename=${encodeURIComponent(filename)}`, {
      method: 'POST', body: bytes, headers: {Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/octet-stream'}});
    const text = await response.text();
    let payload; try { payload = JSON.parse(text); } catch { throw new Error(`The codec returned an unreadable response (${response.status}).`); }
    if (!response.ok || !payload.ok) throw new Error(payload.error?.message || payload.error || `The file could not be opened (${response.status}).`);
    return payload;
  }
  async close() {
    await this.browser?.close().catch(() => {});
    await this.server?.close();
    this.backend?.stop();
    this.page = this.browser = this.server = this.backend = this.origin = null; this.revision = null;
  }
}
