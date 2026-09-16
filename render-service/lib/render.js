'use strict';
/* Drives a headless Chromium that runs the storefront's own renderer.
   Using the same browser engine (and the same gpl-design-render.js) is what makes a
   print file match the proof the customer signed off, down to text metrics and warp
   geometry. A node-canvas reimplementation would look close and be subtly wrong. */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const BROWSER_DIR = path.join(__dirname, '..', 'browser');
const THEME_ASSETS = path.join(__dirname, '..', '..', 'assets');

// Families the customizer offers, with the weights/styles it can apply.
const FONTS = [
  ['Anton', '400'], ['Bebas Neue', '400'], ['Oswald', '400;700'], ['Teko', '700'],
  ['Russo One', '400'], ['Archivo Black', '400'], ['Black Ops One', '400'], ['Bangers', '400'],
  ['Montserrat', '400;700;800'], ['Roboto Condensed', '400;700'], ['Open Sans', '400;700'],
  ['Inter', '400;700'], ['Playfair Display', '400;700'], ['Merriweather', '400;700'],
  ['Permanent Marker', '400'], ['Pacifico', '400'], ['Lobster', '400'], ['Dancing Script', '700']
];

/* Copy the two shared files out of the theme so the harness page loads byte-identical
   code to the storefront. Throws loudly if they are missing — a silently stale copy
   is exactly the drift this service exists to avoid. */
function syncSharedAssets() {
  const wanted = ['gpl-fabric.min.js', 'gpl-design-render.js'];
  for (const name of wanted) {
    const src = path.join(THEME_ASSETS, name);
    if (!fs.existsSync(src)) {
      throw new Error('Missing theme asset ' + src + ' — the render service must sit inside the theme repo.');
    }
    const destName = name === 'gpl-fabric.min.js' ? 'fabric.min.js' : name;
    fs.copyFileSync(src, path.join(BROWSER_DIR, destName));
  }
}

async function ensureFontCss() {
  const cssPath = path.join(BROWSER_DIR, 'fonts.css');
  if (fs.existsSync(cssPath)) return;
  // Non-fatal by design: if Google is unreachable at boot the service must still
  // come up and answer /health, so the problem is diagnosable instead of the
  // container just dying. Text would fall back to a default face until a redeploy.

  // Pull the webfont CSS + files once, at boot, so rendering never depends on a
  // third party being up while an order is being processed.
  const fam = FONTS.map(([f, w]) => 'family=' + encodeURIComponent(f).replace(/%20/g, '+') + ':wght@' + w).join('&');
  const url = 'https://fonts.googleapis.com/css2?' + fam + '&display=swap';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36' }
  });
  if (!res.ok) throw new Error('Could not fetch font CSS: ' + res.status);
  let css = await res.text();
  const urls = [...new Set((css.match(/https:\/\/fonts\.gstatic\.com\/[^)]+/g) || []))];
  fs.mkdirSync(path.join(BROWSER_DIR, 'fonts'), { recursive: true });
  for (const u of urls) {
    const file = u.split('/').pop().split('?')[0];
    const out = path.join(BROWSER_DIR, 'fonts', file);
    if (!fs.existsSync(out)) {
      const r = await fetch(u);
      fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
    }
    css = css.split(u).join('fonts/' + file);
  }
  fs.writeFileSync(cssPath, css);
}

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    const opts = {
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none']
    };
    // In the Docker image Chromium comes from the base image; set
    // PUPPETEER_EXECUTABLE_PATH there (and locally, to reuse an installed Chrome
    // instead of puppeteer's download).
    if (process.env.PUPPETEER_EXECUTABLE_PATH) opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    browserPromise = puppeteer.launch(opts);
  }
  return browserPromise;
}

async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    browserPromise = null;
    await b.close();
  }
}

let bootState = { ok: false, fonts: false, error: null };
function status() { return bootState; }

async function boot() {
  syncSharedAssets();
  try {
    await ensureFontCss();
    bootState.fonts = true;
  } catch (e) {
    // See ensureFontCss: never take the service down over this.
    console.error('[boot] fonts unavailable, continuing without them:', e.message);
    bootState.error = 'fonts: ' + e.message;
  }
  // link the stylesheet into the harness once the file exists
  const htmlPath = path.join(BROWSER_DIR, 'render.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  if (!html.includes('fonts.css')) {
    html = html.replace('<script src="fabric.min.js"></script>',
      '<link rel="stylesheet" href="fonts.css">\n<script src="fabric.min.js"></script>');
    fs.writeFileSync(htmlPath, html);
  }
  bootState.ok = true;
}

/**
 * Render one design.
 * @param {object} opts
 *   design    {objects:[]}   required
 *   widthIn   number         physical width  in inches (omit for uncalibrated)
 *   heightIn  number         physical height in inches
 *   fallbackWidthPx number   used when the area has no real-world size
 *   aspect    number         h/w, used with fallbackWidthPx
 *   dpi       number
 *   player    object|null
 *   maxPixels number
 * @returns {Promise<{buffer:Buffer, width:number, height:number, dpi:number|null, stats:object}>}
 */
async function renderDesign(opts) {
  const dpi = opts.dpi || Number(process.env.PRINT_DPI || 300);
  const calibrated = !!(opts.widthIn > 0 && opts.heightIn > 0);
  let W, H;
  if (calibrated) {
    W = Math.round(opts.widthIn * dpi);
    H = Math.round(opts.heightIn * dpi);
  } else {
    W = Math.round(opts.fallbackWidthPx || 3000);
    H = Math.round(W * (opts.aspect || 1.3333));
  }
  const maxPixels = opts.maxPixels || Number(process.env.MAX_PIXELS || 40000000);
  if (W * H > maxPixels) {
    const scale = Math.sqrt(maxPixels / (W * H));
    W = Math.floor(W * scale); H = Math.floor(H * scale);
  }

  const browser = await getBrowser();
  const page = await browser.newPage();
  let lastPageError = null;
  try {
    page.on('pageerror', (e) => { lastPageError = e; });
    await page.goto('file://' + path.join(BROWSER_DIR, 'render.html'), { waitUntil: 'load' });
    const result = await page.evaluate((payload) => window.gplRenderPrintFile(payload), {
      design: opts.design,
      widthPx: W,
      heightPx: H,
      player: opts.player || null,
      format: 'png'
    });
    if (lastPageError) throw lastPageError;
    const b64 = result.dataUrl.split(',')[1];
    return {
      buffer: Buffer.from(b64, 'base64'),
      width: W,
      height: H,
      dpi: calibrated ? dpi : null,
      calibrated,
      stats: result.stats
    };
  } finally {
    await page.close();
  }
}

module.exports = { boot, renderDesign, closeBrowser, status, FONTS };
