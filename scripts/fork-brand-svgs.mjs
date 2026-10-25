// StykMCP fork identity: writes the brand SVGs in assets/brand/svg (same file names
// as upstream, so no code changes are needed). The StykAnimate name and logo belong
// to the original project; this fork ships its own simple kicking-figure mark.
// Afterwards run `npm run build:brand` and `node scripts/build-web-icons.mjs`.
import {writeFile} from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..'), out = path.join(root, 'assets/brand/svg');
const NAME = 'StykMCP', PRIMARY = '#FF6B2C', INK = '#14182B', LIGHT = '#F5F7FA';

// The figure in a 512 x 640 box: round strokes, a filled head.
const figure = color => `<g fill="none" stroke="${color}" stroke-width="46" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M286 214 L232 392"/><path d="M272 262 L392 238 L462 158"/><path d="M272 262 L170 312 L118 392"/>` +
  `<path d="M232 392 L366 430 L470 396"/><path d="M232 392 L204 500 L166 596"/></g><circle cx="304" cy="124" r="70" fill="${color}"/>`;
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${NAME}"><title>${NAME}</title>${body}</svg>`;
const symbol = color => svg(512, 640, figure(color));
// Keep the upstream tile structure (rx 112, inner group transform): scripts/build-web-icons.mjs relies on it.
const tile = (bg, color) => svg(512, 512, `<rect width="512" height="512" rx="112" fill="${bg}"/><g transform="translate(91 48) scale(.65)"><g>${figure(color)}</g></g>`);
const word = (color, x, y, size, anchor = 'start') => `<text x="${x}" y="${y}" font-family="Inter, Arial, Helvetica, sans-serif" font-weight="700" font-size="${size}" fill="${color}" text-anchor="${anchor}">${NAME}</text>`;
const horizontal = (mark, ink) => svg(1400, 400, `<g transform="translate(40 40) scale(.5)">${figure(mark)}</g>${word(ink, 340, 262, 190)}`);
const stacked = (mark, ink) => svg(900, 900, `<g transform="translate(258 60) scale(.75)">${figure(mark)}</g>${word(ink, 450, 800, 170, 'middle')}`);

const files = {
  'stykanimate-symbol-blue.svg': symbol(PRIMARY), 'stykanimate-symbol-black.svg': symbol(INK), 'stykanimate-symbol-white.svg': symbol('#FFFFFF'),
  'stykanimate-app-icon-blue.svg': tile(INK, PRIMARY), 'stykanimate-app-icon-black.svg': tile('#000000', '#FFFFFF'), 'stykanimate-app-icon-light.svg': tile(LIGHT, PRIMARY),
  'stykanimate-horizontal-primary.svg': horizontal(PRIMARY, INK), 'stykanimate-horizontal-black.svg': horizontal(INK, INK), 'stykanimate-horizontal-white.svg': horizontal('#FFFFFF', '#FFFFFF'),
  'stykanimate-stacked-primary.svg': stacked(PRIMARY, INK), 'stykanimate-stacked-black.svg': stacked(INK, INK), 'stykanimate-stacked-white.svg': stacked('#FFFFFF', '#FFFFFF'),
};
for (const [file, content] of Object.entries(files)) await writeFile(path.join(out, file), content);
const preview = svg(1200, 520, `<rect width="1200" height="520" fill="${LIGHT}"/><rect x="600" width="600" height="520" fill="${INK}"/>` +
  `<g transform="translate(40 40) scale(.3)">${figure(PRIMARY)}</g><g transform="translate(240 40) scale(.3)"><rect width="512" height="512" rx="112" fill="${INK}"/><g transform="translate(91 48) scale(.65)">${figure(PRIMARY)}</g></g>` +
  `<g transform="translate(40 320) scale(.4)">${figure(PRIMARY)}</g>${word(INK, 170, 440, 80)}<g transform="translate(640 40) scale(.3)">${figure('#FFFFFF')}</g>${word('#FFFFFF', 640, 440, 80)}`);
await writeFile(path.join(root, 'assets/brand/preview.svg'), preview);
console.log(`wrote ${Object.keys(files).length} brand SVGs and preview.svg`);
