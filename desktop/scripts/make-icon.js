const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const build = path.join(__dirname, '..', 'build');
fs.mkdirSync(build, { recursive: true });

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return output;
}

function encodePng(width, height, pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    pixels.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function renderIcon(size) {
  const supersample = size <= 256 ? 4 : 2;
  const dimension = size * supersample;
  const pixels = new Float32Array(dimension * dimension * 4);
  const scale = dimension / 1024;
  const blue = [45, 143, 215];
  const pale = [112, 190, 240];

  function blend(x, y, color, alpha) {
    if (x < 0 || y < 0 || x >= dimension || y >= dimension || alpha <= 0) return;
    const index = (y * dimension + x) * 4;
    const previous = pixels[index + 3];
    const next = alpha + previous * (1 - alpha);
    for (let channel = 0; channel < 3; channel++) {
      pixels[index + channel] = (color[channel] * alpha + pixels[index + channel] * previous * (1 - alpha)) / next;
    }
    pixels[index + 3] = next;
  }

  function disc(cx, cy, radius, color, alpha = 1) {
    const edge = Math.max(1, supersample);
    const extent = radius + edge;
    for (let y = Math.floor(cy - extent); y <= Math.ceil(cy + extent); y++) {
      for (let x = Math.floor(cx - extent); x <= Math.ceil(cx + extent); x++) {
        const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const coverage = Math.max(0, Math.min(1, radius + edge / 2 - distance));
        if (coverage) blend(x, y, color, alpha * coverage);
      }
    }
  }

  function ring(cx, cy, radius, width, color, alpha = 1) {
    const edge = Math.max(1, supersample);
    const extent = radius + width / 2 + edge;
    for (let y = Math.floor(cy - extent); y <= Math.ceil(cy + extent); y++) {
      for (let x = Math.floor(cx - extent); x <= Math.ceil(cx + extent); x++) {
        const distance = Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius);
        const coverage = Math.max(0, Math.min(1, width / 2 + edge / 2 - distance));
        if (coverage) blend(x, y, color, alpha * coverage);
      }
    }
  }

  function line(x1, y1, x2, y2, width, color, alpha = 1) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / Math.max(1, width / 3)));
    for (let step = 0; step <= steps; step++) {
      const ratio = step / steps;
      disc(x1 + (x2 - x1) * ratio, y1 + (y2 - y1) * ratio, width / 2, color, alpha);
    }
  }

  const cx = 512 * scale;
  const cy = 512 * scale;
  const orbitRadius = 400 * scale;
  for (let width = 52; width >= 28; width -= 8) ring(cx, cy, orbitRadius, width * scale, pale, 0.008);
  ring(cx, cy, orbitRadius, 20 * scale, pale, 0.08);
  ring(cx, cy, orbitRadius, 15 * scale, blue, 0.94);
  const electrons = [[112, 512], [912, 512]];
  const nucleus = [[448, 447, blue], [550, 447, pale], [401, 548, pale], [512, 560, blue], [623, 548, pale]];
  for (const [x, y] of electrons) {
    disc(x * scale, y * scale, 59 * scale, pale, 0.04);
    disc(x * scale, y * scale, 48 * scale, blue, 1);
  }
  for (const [x, y, color] of nucleus) {
    disc(x * scale, y * scale, 50 * scale, pale, 0.04);
    disc(x * scale, y * scale, 42 * scale, color, 1);
  }

  const output = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const totals = [0, 0, 0, 0];
      for (let sy = 0; sy < supersample; sy++) {
        for (let sx = 0; sx < supersample; sx++) {
          const source = (((y * supersample + sy) * dimension) + x * supersample + sx) * 4;
          const alpha = pixels[source + 3];
          totals[0] += pixels[source] * alpha;
          totals[1] += pixels[source + 1] * alpha;
          totals[2] += pixels[source + 2] * alpha;
          totals[3] += alpha;
        }
      }
      const samples = supersample * supersample;
      const alpha = totals[3] / samples;
      const target = (y * size + x) * 4;
      output[target] = totals[3] ? Math.round(totals[0] / (samples * alpha)) : 0;
      output[target + 1] = totals[3] ? Math.round(totals[1] / (samples * alpha)) : 0;
      output[target + 2] = totals[3] ? Math.round(totals[2] / (samples * alpha)) : 0;
      output[target + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, output);
}

const iconSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const images = iconSizes.map(size => ({ size, png: renderIcon(size) }));
const directorySize = 6 + images.length * 16;
const icoHeader = Buffer.alloc(directorySize);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(images.length, 4);
let offset = directorySize;
images.forEach(({ size, png }, index) => {
  const entry = 6 + index * 16;
  icoHeader[entry] = size === 256 ? 0 : size;
  icoHeader[entry + 1] = size === 256 ? 0 : size;
  icoHeader[entry + 2] = 0;
  icoHeader[entry + 3] = 0;
  icoHeader.writeUInt16LE(1, entry + 4);
  icoHeader.writeUInt16LE(32, entry + 6);
  icoHeader.writeUInt32LE(png.length, entry + 8);
  icoHeader.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs><filter id="glow" x="-35%" y="-35%" width="170%" height="170%"><feGaussianBlur stdDeviation="20" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
  <g fill="none" stroke="#2d8fd7" stroke-linecap="round" filter="url(#glow)"><circle cx="512" cy="512" r="400" stroke-width="15"/></g>
  <g fill="#2d8fd7" filter="url(#glow)"><circle cx="112" cy="512" r="48"/><circle cx="912" cy="512" r="48"/><circle cx="448" cy="447" r="42"/><circle cx="512" cy="560" r="42"/></g>
  <g fill="#70bef0" filter="url(#glow)"><circle cx="550" cy="447" r="42"/><circle cx="401" cy="548" r="42"/><circle cx="623" cy="548" r="42"/></g>
</svg>`;

fs.writeFileSync(path.join(build, 'helium-5.svg'), svg);
fs.writeFileSync(path.join(build, 'helium-5.png'), renderIcon(1024));
fs.writeFileSync(path.join(build, 'helium-5.ico'), Buffer.concat([icoHeader, ...images.map(image => image.png)]));
console.log(`Generated transparent 1024px PNG and ${images.length}-size ICO.`);
