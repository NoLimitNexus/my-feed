// Draws the home-screen icons (site/icon-192.png, site/icon-512.png): the same feed symbol
// as site/icon.svg on a dark square, kept inside the middle so phone icon masks never cut it.
// Run again only if the icon changes: npm run icons
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [16, 19, 24];
const FG = [242, 153, 74];
const CORNER = [0.30, 0.70];   // the arcs' centre, as in icon.svg

function inSymbol(x, y) {
  if (Math.hypot(x - 0.355, y - 0.645) <= 0.058) return true;   // the dot
  const dx = x - CORNER[0];
  const dy = CORNER[1] - y;
  if (dx < 0 || dy < 0) return false;
  const r = Math.hypot(dx, dy);
  return (r >= 0.19 && r <= 0.255) || (r >= 0.32 && r <= 0.385);
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function icon(size) {
  const SS = 4;   // 4x4 samples per pixel for smooth edges
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;   // no filter
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (inSymbol((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size)) hit++;
        }
      }
      const t = hit / (SS * SS);
      for (let c = 0; c < 3; c++) raw[row + 1 + x * 3 + c] = Math.round(BG[c] + (FG[c] - BG[c]) * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  writeFileSync(new URL(`../site/icon-${size}.png`, import.meta.url), icon(size));
  console.log(`site/icon-${size}.png`);
}
