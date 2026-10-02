// Regenerates the PWA and home-screen icons from public/favicon.svg (the light variant of the mark):
// icon-192.png and icon-512.png for the web app manifest, apple-touch-icon.png (180 px) for iOS.
// Each is an opaque 8-bit RGB PNG: the mark at about 60% of the canvas, centred on white.
// Run with: node apps/web/scripts/icons.ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

const PUBLIC = resolve(import.meta.dirname, '../public');
const LIGHT_DISC = '#0b0b0d';
const SIZES: Record<string, number> = { 'icon-192.png': 192, 'icon-512.png': 512, 'apple-touch-icon.png': 180 };

const source = await readFile(resolve(PUBLIC, 'favicon.svg'), 'utf8');
// The favicon follows the device's colour scheme; the raster icons always use the light variant.
const light = source.replace(/<style>[\s\S]*?<\/style>/, '').replace('class="disc"', `fill="${LIGHT_DISC}"`);

for (const [file, size] of Object.entries(SIZES)) {
  const mark = Math.round(size * 0.6);
  const markPng = await sharp(Buffer.from(light), { density: 1200 }).resize(mark, mark).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 3, background: '#ffffff' } })
    .composite([{ input: markPng, gravity: 'centre' }])
    .removeAlpha()
    .png()
    .toFile(resolve(PUBLIC, file));
  console.log(`wrote ${file} (${size}x${size})`);
}
