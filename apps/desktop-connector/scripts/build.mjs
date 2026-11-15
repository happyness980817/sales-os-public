import { build } from 'esbuild';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
await mkdir('dist/renderer', { recursive: true });
await build({ entryPoints: ['src/main.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: 'dist/main.cjs' });
await build({ entryPoints: ['src/preload.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], outfile: 'dist/preload.cjs' });
for (const name of ['index.html', 'app.css', 'app.js']) await cp(`src/renderer/${name}`, `dist/renderer/${name}`);
// Small original monochrome application mark; no remote icon dependency.
function crc32(data) { let value = 0xffffffff; for (const byte of data) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); } return (value ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const kind = Buffer.from(type); const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([kind, data]))); return Buffer.concat([size, kind, data, crc]); }
const size = 64, rows = Buffer.alloc((size * 4 + 1) * size);
const glyph = ['01111', '11000', '11000', '01110', '00011', '00011', '11110'];
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const corner = Math.max(0, 11 - Math.min(x, size - 1 - x)), vertical = Math.max(0, 11 - Math.min(y, size - 1 - y));
  const visible = corner * corner + vertical * vertical <= 121;
  const gx = Math.floor((x - 17) / 6), gy = Math.floor((y - 11) / 6);
  const white = gx >= 0 && gx < 5 && gy >= 0 && gy < 7 && glyph[gy][gx] === '1';
  const offset = y * (size * 4 + 1) + 1 + x * 4;
  rows[offset] = rows[offset + 1] = rows[offset + 2] = white ? 245 : 18; rows[offset + 3] = visible ? 255 : 0;
}
const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
await writeFile('dist/icon.png', png);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico[6] = ico[7] = size; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
await writeFile('dist/icon.ico', Buffer.concat([ico, png]));
console.log('SALES-OS Connect build complete.');
