// Makes the app icon and the iPhone splash screens from one design: four burner flames (Family, Friends,
// Health, Work, in their own colors) on a true-black stovetop. Run after changing the design:
//   node scripts/make-icons.mjs
// Writes public/icon.svg, the PNG icons, and public/splash/*.png (rendered with Playwright's Chromium).
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const pub = fileURLToPath(new URL('../public/', import.meta.url));

const PALETTES = [
  { core: '#fff4d6', mid: '#ffae3b', outer: '#ff4d12' }, // Family
  { core: '#ffe8ef', mid: '#ff7aa2', outer: '#d0175f' }, // Friends
  { core: '#e8fbff', mid: '#5ad1ff', outer: '#1d4ed8' }, // Health
  { core: '#f4ecff', mid: '#b58cff', outer: '#6421d6' }, // Work
];

const FLAME = 'M0-190C40-120 110-80 110 10a110 110 0 0 1-220 0c0-50 30-80 50-110 5 40 25 60 45 70C-20-70-25-130 0-190z';

/** The art on a 1024 square. `inset` shrinks it toward the middle (maskable icons keep a safe zone). */
function art(inset = 1) {
  const cells = [
    [300, 300],
    [724, 300],
    [300, 724],
    [724, 724],
  ];
  const defs = PALETTES.map(
    (p, i) => `
    <radialGradient id="f${i}" cx="50%" cy="72%" r="60%">
      <stop offset="0" stop-color="${p.core}"/>
      <stop offset=".32" stop-color="${p.mid}"/>
      <stop offset=".72" stop-color="${p.outer}" stop-opacity=".85"/>
      <stop offset="1" stop-color="${p.outer}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="h${i}" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="${p.mid}" stop-opacity=".55"/>
      <stop offset="1" stop-color="${p.mid}" stop-opacity="0"/>
    </radialGradient>`,
  ).join('');
  const burners = cells
    .map(([x, y], i) => {
      const p = PALETTES[i];
      return `
    <g transform="translate(${x} ${y})">
      <circle r="205" fill="url(#h${i})"/>
      <ellipse cx="0" cy="118" rx="150" ry="34" fill="none" stroke="${p.outer}" stroke-opacity=".55" stroke-width="10"/>
      <ellipse cx="0" cy="118" rx="104" ry="22" fill="none" stroke="${p.mid}" stroke-opacity=".35" stroke-width="6"/>
      <g transform="translate(0 60) scale(.98)"><path d="${FLAME}" fill="url(#f${i})"/></g>
      <g transform="translate(0 66) scale(.44)"><path d="${FLAME}" fill="${p.core}" fill-opacity=".85"/></g>
    </g>`;
    })
    .join('');
  const s = inset;
  return `<defs>${defs}
    <radialGradient id="bg" cx="50%" cy="45%" r="70%">
      <stop offset="0" stop-color="#1a0d06"/>
      <stop offset="1" stop-color="#000"/>
    </radialGradient></defs>
  <g transform="translate(512 512) scale(${s}) translate(-512 -512)">${burners}</g>`;
}

function iconSvg(inset = 1) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="#000"/>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  ${art(inset)}
</svg>`;
}

function splashHtml(w, h) {
  // Physical pixels: the art sits a little above center, the name below it, like the app's launch.
  const size = Math.round(w * 0.46);
  return `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:-apple-system,'SF Pro Display','Segoe UI',sans-serif">
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}" style="margin-top:-${Math.round(h * 0.06)}px">${art(0.92)}</svg>
  <div style="margin-top:${Math.round(w * 0.05)}px;color:#fff;font-size:${Math.round(w * 0.072)}px;font-weight:800;letter-spacing:-0.01em">Four Burners</div>
  <div style="margin-top:${Math.round(w * 0.015)}px;color:#a8a8b3;font-size:${Math.round(w * 0.034)}px;letter-spacing:.2em;text-transform:uppercase">Family · Friends · Health · Work</div>
</body></html>`;
}

/** iPhone splash sizes (portrait, physical pixels) with the media query iOS matches them by. */
export const SPLASHES = [
  { name: 'iphone-17-pro-max', w: 1320, h: 2868, dw: 440, dh: 956 },
  { name: 'iphone-17-pro', w: 1206, h: 2622, dw: 402, dh: 874 },
  { name: 'iphone-16-plus', w: 1290, h: 2796, dw: 430, dh: 932 },
  { name: 'iphone-15', w: 1179, h: 2556, dw: 393, dh: 852 },
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(`${pub}icon.svg`, iconSvg());
  mkdirSync(`${pub}splash`, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const png = async (svg, size, file) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<body style="margin:0;background:#000">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
    await page.screenshot({ path: `${pub}${file}`, clip: { x: 0, y: 0, width: size, height: size } });
  };
  await png(iconSvg(), 180, 'apple-touch-icon.png');
  await png(iconSvg(), 192, 'icon-192.png');
  await png(iconSvg(), 512, 'icon-512.png');
  await png(iconSvg(0.8), 512, 'icon-maskable-512.png');
  for (const s of SPLASHES) {
    await page.setViewportSize({ width: s.w, height: s.h });
    await page.setContent(splashHtml(s.w, s.h));
    await page.screenshot({ path: `${pub}splash/${s.name}.png` });
  }
  await browser.close();
  console.log('Wrote icon.svg, apple-touch-icon.png, icon-192/512.png, icon-maskable-512.png, splash/*.png');
  console.log(
    SPLASHES.map(
      (s) =>
        `<link rel="apple-touch-startup-image" media="(device-width: ${s.dw}px) and (device-height: ${s.dh}px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" href="/splash/${s.name}.png" />`,
    ).join('\n'),
  );
}
