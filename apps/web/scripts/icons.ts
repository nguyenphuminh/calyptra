// Regenerates the PWA and home-screen icons from public/favicon.svg (the dark variant of the mark):
// icon-192.png and icon-512.png for the web app manifest, apple-touch-icon.png (180 px) for iOS.
// Each is an opaque 8-bit RGB PNG: the mark at about 60% of the canvas, centred on the dark page colour.
// Run with: node apps/web/scripts/icons.ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

const PUBLIC = resolve(import.meta.dirname, '../public');
/** The dark theme's page colour, also the manifest's theme and background colour. */
const BACKGROUND = '#0f0f12';
const SIZES: Record<string, number> = { 'icon-192.png': 192, 'icon-512.png': 512, 'apple-touch-icon.png': 180 };

const source = await readFile(resolve(PUBLIC, 'favicon.svg'), 'utf8');
// The favicon follows the device's colour scheme through classes; the raster icons always use the dark
// variant, so each class becomes the attribute its dark-scheme rule sets (e.g. class="s0" → stop-color).
const darkRules = /@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\}\s*<\/style>/.exec(source)?.[1];
if (!darkRules) throw new Error('favicon.svg has no dark-scheme rules');
let dark = source.replace(/<style>[\s\S]*?<\/style>/, '');
for (const [, name, property, value] of darkRules.matchAll(/\.([\w-]+)\s*\{\s*([\w-]+)\s*:\s*([^;}]+?)\s*;?\s*\}/g)) {
  dark = dark.replaceAll(`class="${name}"`, `${property}="${value}"`);
}
if (dark.includes('class=')) throw new Error('a class of favicon.svg has no dark-scheme rule');

for (const [file, size] of Object.entries(SIZES)) {
  const mark = Math.round(size * 0.6);
  const markPng = await sharp(Buffer.from(dark), { density: 1200 }).resize(mark, mark).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 3, background: BACKGROUND } })
    .composite([{ input: markPng, gravity: 'centre' }])
    .removeAlpha()
    .png()
    .toFile(resolve(PUBLIC, file));
  console.log(`wrote ${file} (${size}x${size})`);
}
