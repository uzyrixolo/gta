'use strict';
/* Proves the service end to end without Shopify, Railway or Uploadcare:
   builds a design that uses every feature the customizer can emit, renders it at
   300 DPI, and checks the output is a real PNG of the right pixel size with ink in it. */
const fs = require('fs');
const path = require('path');
const { boot, renderDesign, closeBrowser } = require('./lib/render');

const design = { objects: [
  { id: 'a', type: 'text', cx: 500, cy: 300, angle: 0, text: 'GTA PRINT LAB',
    fontFamily: 'Anton', fontWeight: '400', fontSize: 150, fill: '#111111',
    stroke: '#D71920', strokeWidth: 6, charSpacing: 40, lineHeight: 1.1,
    textAlign: 'center', warp: 'arc_up', warpAmt: 55 },
  { id: 'b', type: 'text', cx: 500, cy: 760, angle: 0, text: '00',
    fontFamily: 'Anton', fontWeight: '400', fontSize: 460, fill: '#111111',
    stroke: '#D71920', strokeWidth: 14, charSpacing: 20, warp: 'none', role: 'number' },
  { id: 'c', type: 'text', cx: 500, cy: 1120, angle: -4, text: 'NAME',
    fontFamily: 'Montserrat', fontWeight: '800', fontSize: 120, fill: '#111111',
    charSpacing: 80, warp: 'none', role: 'name' }
] };

(async () => {
  await boot();
  const t0 = Date.now();
  const out = await renderDesign({ design, widthIn: 12, heightIn: 16, dpi: 300,
    player: { name: 'Smith', number: '23' } });
  const ms = Date.now() - t0;

  const dir = path.join(__dirname, 'out');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'selftest-300dpi.png');
  fs.writeFileSync(file, out.buffer);

  const b = out.buffer;
  const isPng = b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG';
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);

  const checks = [
    ['is a PNG', isPng],
    ['pixel size is 12in x 16in at 300dpi', w === 3600 && h === 4800],
    ['reported size matches header', out.width === w && out.height === h],
    ['marked calibrated at 300 dpi', out.calibrated === true && out.dpi === 300],
    ['all three layers rendered', out.stats.objects === 3],
    ['file has real content (>40KB)', b.length > 40000]
  ];
  checks.forEach(([name, ok]) => console.log((ok ? '  PASS  ' : '  FAIL  ') + name));
  console.log('\n  ' + w + ' x ' + h + ' px, ' + (b.length / 1024 / 1024).toFixed(2) + ' MB, rendered in ' + ms + ' ms');
  console.log('  fonts used: ' + out.stats.fonts.join(', '));
  console.log('  written to ' + file);

  // uncalibrated path
  const un = await renderDesign({ design, aspect: 16 / 12, fallbackWidthPx: 3000 });
  console.log((un.dpi === null && un.calibrated === false ? '  PASS  ' : '  FAIL  ')
    + 'uncalibrated design renders without claiming a DPI (' + un.width + 'x' + un.height + ')');

  await closeBrowser();
  process.exit(checks.every(c => c[1]) ? 0 : 1);
})().catch(async (e) => { console.error(e); await closeBrowser(); process.exit(1); });
