// Génère les icônes PNG de l'app (une flamme sur fond orange), sans dépendance externe.
// Usage : node scripts/make-icons.mjs

import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync } from "node:fs";

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // pas de filtre
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8 bits, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Flamme : un cercle en bas prolongé par une pointe vers le haut. Coordonnées normalisées [-1, 1].
function inFlame(x, y, scale, dy) {
  x /= scale; y = (y - dy) / scale;
  const cy = 0.28, r = 0.5;
  if (x * x + (y - cy) ** 2 <= r * r) return true;
  const tip = -0.95;
  if (y < cy && y > tip) {
    const t = (y - tip) / (cy - tip); // 0 à la pointe, 1 au centre du cercle
    const half = r * Math.pow(Math.sin((t * Math.PI) / 2), 1.8);
    // légère torsion pour un aspect plus naturel
    const shift = 0.12 * Math.sin((1 - t) * Math.PI) * (1 - t);
    return Math.abs(x - shift) <= half;
  }
  return false;
}

function pixelFor(x, y, size) {
  const SS = 4; // suréchantillonnage pour lisser les bords
  let outer = 0, inner = 0;
  for (let i = 0; i < SS; i++) for (let j = 0; j < SS; j++) {
    const nx = ((x + (i + 0.5) / SS) / size) * 2 - 1;
    const ny = ((y + (j + 0.5) / SS) / size) * 2 - 1;
    if (inFlame(nx, ny, 0.66, -0.02)) outer++;
    if (inFlame(nx, ny, 0.34, 0.17)) inner++;
  }
  outer /= SS * SS; inner /= SS * SS;
  // fond : dégradé orange chaud du haut vers le bas
  const t = y / size;
  const bg = [Math.round(246 - 20 * t), Math.round(120 - 40 * t), Math.round(40 - 20 * t)];
  const white = [255, 248, 240];
  const core = [255, 196, 92];
  const mix = (a, b, k) => a.map((v, n) => Math.round(v * (1 - k) + b[n] * k));
  let c = mix(bg, white, outer);
  c = mix(c, core, inner);
  return [...c, 255];
}

const out = new URL("../public/", import.meta.url);
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  writeFileSync(new URL(name, out), png(size, pixelFor));
  console.log("écrit", name);
}
