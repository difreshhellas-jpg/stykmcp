// Browser side of the StykMCP render bridge. It reuses the app's own export
// renderer (Canvas 2D in a worker), so previews and exports match the editor's
// File → Export output exactly. Node drives it through window.__stykMcp.
import {ExportFrameRenderer} from '../../src/export-frame-renderer.mjs';
import {DocumentExporter} from '../../src/document-export.mjs';

let session = null;

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

async function open(report, width, height, smoothing) {
  const key = `${width}x${height}:${smoothing}`;
  if (session && session.key === key && session.report === report) return session.renderer;
  session?.renderer.dispose();
  const renderer = new ExportFrameRenderer({width, height, smoothing, canvas: document.createElement('canvas')});
  await renderer.load(report);
  session = {key, report, renderer};
  return renderer;
}

let current = null, exporter = null;
window.__stykMcp = {
  /** Encode the current document as styk, piv or stk through the app's own exporter and codec service. */
  async save({format, name, figureTypeId, codecOrigin, token}) {
    exporter ??= new DocumentExporter({baseURL: codecOrigin, token});
    return blobToBase64(await exporter.export(current, {format, name, figureTypeId}));
  },
  ready: true,
  /** Receive the document once per revision; later calls only name ticks. */
  setDocument(json) { current = JSON.parse(json); session?.renderer.dispose(); session = null; return true; },
  /** PNG frames (base64) for the given ticks at the given output size. */
  async frames({ticks, width, height, smoothing = 'edges', alpha = false}) {
    const renderer = await open(current, width, height, smoothing), out = [];
    for (const tick of ticks) out.push(await blobToBase64((await renderer.renderNativeTick(tick, {preserveAlpha: alpha})).blob));
    return out;
  },
  /** One contact-sheet PNG: frames scaled into a labelled grid. */
  async sheet({ticks, width, height, cellWidth, columns, smoothing = 'edges'}) {
    const renderer = await open(current, width, height, smoothing);
    const cellHeight = Math.max(1, Math.round(cellWidth * height / width)), label = 14;
    const cols = Math.min(columns, ticks.length), rows = Math.ceil(ticks.length / cols);
    const sheet = new OffscreenCanvas(cols * cellWidth, rows * (cellHeight + label)), context = sheet.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, sheet.width, sheet.height);
    context.font = '11px sans-serif'; context.textBaseline = 'top';
    for (const [index, tick] of ticks.entries()) {
      const bitmap = await createImageBitmap((await renderer.renderNativeTick(tick)).blob);
      const x = (index % cols) * cellWidth, y = Math.floor(index / cols) * (cellHeight + label);
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, x, y + label, cellWidth, cellHeight); bitmap.close();
      context.fillStyle = '#333'; context.fillText(`f${tick + 1}`, x + 3, y + 1);
      context.strokeStyle = '#ccc'; context.strokeRect(x + .5, y + label + .5, cellWidth - 1, cellHeight - 1);
    }
    return blobToBase64(await sheet.convertToBlob({type: 'image/png'}));
  },
};
