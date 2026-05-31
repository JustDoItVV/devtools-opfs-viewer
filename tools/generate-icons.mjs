// Generates the extension's PNG icons (a simple flat folder) with no external
// deps — hand-rolled PNG encoder over Node's zlib. Run: node tools/generate-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // 10..12 = compression/filter/interlace = 0

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[(stride + 1) * y] = 0; // filter: none
    rgba.copy(raw, (stride + 1) * y + 1, stride * y, stride * (y + 1));
  }

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawFolderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4); // transparent
  const fill = (x0, y0, x1, y1, color) => {
    const xa = Math.max(0, Math.round(x0 * size));
    const ya = Math.max(0, Math.round(y0 * size));
    const xb = Math.min(size, Math.round(x1 * size));
    const yb = Math.min(size, Math.round(y1 * size));
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const o = (y * size + x) * 4;
        rgba[o] = color[0];
        rgba[o + 1] = color[1];
        rgba[o + 2] = color[2];
        rgba[o + 3] = color[3];
      }
    }
  };

  const tab = [37, 99, 235, 255]; // darker blue
  const body = [59, 130, 246, 255]; // blue
  fill(0.14, 0.26, 0.52, 0.42, tab); // folder tab
  fill(0.12, 0.36, 0.88, 0.8, body); // folder body
  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(OUT_DIR, `${size}.png`), drawFolderIcon(size));
}
