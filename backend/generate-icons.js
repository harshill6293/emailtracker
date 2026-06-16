const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const sizes = [16, 48, 128];
const outputDir = path.join(__dirname, '..', 'extension', 'icons');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// ─── Try canvas first; fall back to pure-JS PNG encoder ──────────────────────

let useCanvas = false;
let createCanvas;
try {
  ({ createCanvas } = require('canvas'));
  useCanvas = true;
  console.log('Using canvas for icon generation.');
} catch {
  console.log('canvas not available — using pure-JS PNG encoder (solid color fallback).');
}

// ─── Pure-JS PNG encoder ──────────────────────────────────────────────────────

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createSolidPNG(width, height, r, g, b) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB truecolor

  const rowBytes = width * 3;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0; // filter byte: None
    for (let x = 0; x < width; x++) {
      const off = y * (rowBytes + 1) + 1 + x * 3;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
    }
  }

  const compressed = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ─── Generate icons ───────────────────────────────────────────────────────────

for (const size of sizes) {
  const outPath = path.join(outputDir, `icon${size}.png`);

  if (useCanvas) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#185FA5';
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, size * 0.18);
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold ${Math.floor(size * 0.65)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('T', size / 2, size / 2 + size * 0.03);

    fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  } else {
    // Solid #185FA5 (r=24, g=95, b=165)
    fs.writeFileSync(outPath, createSolidPNG(size, size, 24, 95, 165));
  }

  console.log(`Generated ${outPath}`);
}

console.log('Icons generated.');
